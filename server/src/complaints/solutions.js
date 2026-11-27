// Solution mining: what we offered on each complaint, and how the client took it.
// The whole Kustomer history now lives in our own conversations and messages tables
// (docs/kustomer-migration.md), so for every complaint case, whatever its source, we read the
// client's conversations around it (client messages, our replies, internal notes), redact
// them (redact.js) and ask Claude to pull out: what the client asked for, each offer we made
// in order with the client's response, what was finally agreed, and how the client sounded at
// the end. That is the raw material for ranking responses: not just "what we did", but what
// we offered, what was turned down, and what actually landed.
//
// Off unless ANTHROPIC_API_KEY is set. Read-only on every source; writes only our own tables.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { rungForRefund } from './settings.js';

const MODEL = 'claude-opus-5-5';
const MAX_CHARS = 16_000;

// What an offer (or a request) can be. Kept short so the numbers per kind mean something.
export const OFFER_KINDS = [
  { key: 'apology', label: 'Apology only' },
  { key: 'credit', label: 'Credit on a future clean' },
  { key: 'discount_next', label: 'Discount on the next clean' },
  { key: 'reclean', label: 'Reclean' },
  { key: 'partial_refund', label: 'Partial refund' },
  { key: 'full_refund', label: 'Full refund' },
  { key: 'same_cleaner', label: 'Their regular cleaner back' },
  { key: 'different_cleaner', label: 'A different cleaner' },
  { key: 'extra_time', label: 'Longer visit / more cleaners' },
  { key: 'free_add_on', label: 'Free add-on (oven, fridge, windows…)' },
  { key: 'damage_reimbursement', label: 'Damage reimbursement' },
  { key: 'manager_call', label: 'Call from a manager' },
  { key: 'other', label: 'Something else' },
];
export const OFFER_KEYS = OFFER_KINDS.map((k) => k.key);
export const offerLabel = (k) => OFFER_KINDS.find((x) => x.key === k)?.label || (k === 'nothing_specific' ? 'Nothing specific' : k || '—');
export const RESPONSES = ['accepted', 'declined', 'countered', 'no_reply', 'unclear'];
export const ENDINGS = ['satisfied', 'neutral', 'unhappy', 'unknown'];

const Offer = z.object({
  kind: z.enum(OFFER_KEYS),
  amount: z.number().nullable(),
  pct: z.number().nullable(),
  detail: z.string(),
  client_response: z.enum(RESPONSES),
});
const Result = z.object({
  asked_for: z.enum([...OFFER_KEYS, 'nothing_specific']),
  offers: z.array(Offer),
  final_kind: z.enum([...OFFER_KEYS, 'none']),
  final_detail: z.string(),
  client_end: z.enum(ENDINGS),
  said_will_leave: z.boolean(),
  said_will_stay: z.boolean(),
  handling: z.string(),
});

const SYSTEM = `You read customer-service threads about complaints for a residential cleaning company in Ottawa,
and record what the company offered and how the client took it.
Personal details have been replaced with placeholders like [name] and [address]; never try to recover them.
Lines are marked CLIENT (the customer), US (our support team) or NOTE (our internal note, not seen by the client).

Offer kinds: ${OFFER_KINDS.map((k) => `${k.key} (${k.label})`).join('; ')}.
- asked_for: what the client asked for, if they asked for something specific; otherwise nothing_specific.
- offers: every distinct thing US offered or promised the client, in the order offered. An internal NOTE that says a
  refund or credit was issued counts as an offer the client accepted. amount: dollars if stated, else null.
  pct: percent if stated (a 30% refund is pct 30), else null. detail: a few plain words, no names or amounts that
  identify the client. client_response: accepted, declined, countered (asked for more or something else), no_reply,
  or unclear.
- final_kind: what was finally agreed or done; none if nothing was. final_detail: a few plain words.
- client_end: how the client sounded in their last message (satisfied, neutral, unhappy, or unknown if they never wrote back).
- said_will_leave / said_will_stay: the client said so in the thread.
- handling: one plain sentence on how we handled it (speed, tone, whether we answered what they asked), no names.
If the thread is not about this complaint, record no offers, final_kind none and client_end unknown.`;

export function createSolutionReader({ apiKey, log = { warn() {} }, client = null } = {}) {
  if (!apiKey && !client) return null;
  const anthropic = client || new Anthropic({ apiKey, maxRetries: 3 });
  return async function read(thread, { complaint = '' } = {}) {
    let text = String(thread || '');
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS * 0.6)}\n[…]\n${text.slice(-MAX_CHARS * 0.4)}`;
    try {
      const response = await anthropic.messages.parse({
        model: MODEL,
        max_tokens: 3000,
        output_config: { effort: 'low', format: zodOutputFormat(Result) },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `<complaint>${complaint}</complaint>\n<thread>\n${text}\n</thread>` }],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
      return response.parsed_output;
    } catch (err) {
      if (err instanceof Anthropic.APIError) log.warn('Solution mining: Claude call failed', { status: err.status });
      else log.warn('Solution mining failed', { error: err.message });
      return null;
    }
  };
}

/** A thread as Claude reads it: who said what, oldest first. Pure; redaction is the caller's. */
export function formatThread(messages) {
  return messages
    .map((m) => {
      const who = m.kind === 'note' ? 'NOTE' : m.direction === 'in' ? 'CLIENT' : 'US';
      const when = new Date(m.created_at).toISOString().slice(0, 10);
      const body = String(m.body || '').replace(/\n{3,}/g, '\n\n').trim();
      return body ? `${who} (${when}${m.channel ? `, ${m.channel}` : ''}):\n${body}` : null;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * An offer the client took (or the final answer) as a resolution on the case, in the ladder's
 * terms, so "what we did" covers cases with no refund post or $0 visit behind them.
 * Returns null for offers that don't map to the ladder (a cleaner change, a manager call).
 */
export function offerToResolution(o) {
  if (!o) return null;
  switch (o.kind) {
    case 'apology': return { rung: 'L0', action: 'apology', pct: null, amount: null };
    case 'credit':
    case 'discount_next': {
      const amt = Number(o.amount) || null;
      return { rung: amt != null && amt <= 5 ? 'L1' : 'L2', action: 'credit', pct: o.pct ?? null, amount: amt };
    }
    case 'reclean': return { rung: 'L3', action: 'reclean_full', pct: null, amount: null };
    case 'partial_refund': return { rung: o.pct != null ? rungForRefund(o.pct) : 'L5', action: 'refund', pct: o.pct ?? null, amount: Number(o.amount) || null };
    case 'full_refund': return { rung: 'L7', action: 'refund', pct: 100, amount: Number(o.amount) || null };
    case 'damage_reimbursement': return { rung: 'damage_reimbursement', action: 'damage_reimbursement', pct: null, amount: Number(o.amount) || null };
    default: return null;
  }
}

/** Clean up what Claude returned: valid kinds only, offers capped, text trimmed. Pure. */
export function normalizeSolution(r) {
  if (!r) return null;
  const offers = (r.offers || [])
    .filter((o) => OFFER_KEYS.includes(o.kind))
    .slice(0, 8)
    .map((o) => ({ kind: o.kind, amount: Number.isFinite(o.amount) ? o.amount : null, pct: Number.isFinite(o.pct) ? Math.max(0, Math.min(100, o.pct)) : null, detail: String(o.detail || '').slice(0, 160), client_response: RESPONSES.includes(o.client_response) ? o.client_response : 'unclear' }));
  return {
    asked_for: OFFER_KEYS.includes(r.asked_for) ? r.asked_for : 'nothing_specific',
    offers,
    final_kind: OFFER_KEYS.includes(r.final_kind) ? r.final_kind : null,
    final_detail: String(r.final_detail || '').slice(0, 200) || null,
    client_end: ENDINGS.includes(r.client_end) ? r.client_end : 'unknown',
    said_will_leave: !!r.said_will_leave,
    said_will_stay: !!r.said_will_stay,
    handling: String(r.handling || '').slice(0, 300) || null,
  };
}
