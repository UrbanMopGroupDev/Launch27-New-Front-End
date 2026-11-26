// What every SMS provider shares: its row in sms_provider_state (kept in memory too, so sending
// never queries the database from inside a reply's transaction), the durable queue of incoming
// texts (sms_events), and turning each one into an inbox message through ingestInbound().
import { normalizePhone } from '../normalize.js';
import { contactsByIdentity, ingestInbound } from '../service.js';

export const MIN = 60_000;
const MAX_EVENT_ATTEMPTS = 8;

// Error text kept for admins: the reason, never a phone number or message text.
export const sanitize = (err) => String(err?.message || err).replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]').slice(0, 300);

export function createProviderState(db, provider, { log = () => {}, now = () => Date.now() } = {}) {
  let cached = null;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0] || null;
  const ensure = () => db.query('INSERT INTO sms_provider_state (provider) VALUES ($1) ON CONFLICT DO NOTHING', [provider]);
  const api = {
    cached: () => cached,
    async state() {
      await ensure();
      cached = await one('SELECT * FROM sms_provider_state WHERE provider = $1', [provider]);
      return cached;
    },
    async setState(fields) {
      const keys = Object.keys(fields);
      await ensure();
      const row = await one(`UPDATE sms_provider_state SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE provider = $1 RETURNING *`, [provider, ...keys.map((k) => fields[k])]);
      if (row) cached = row;
      return row;
    },
    recordError(what, err) {
      log('error', `sms (${provider}): ${what} failed`, { error: sanitize(err) });
      return api.setState({ last_error: `${what}: ${sanitize(err)}`, last_error_at: new Date(now()) }).catch(() => {});
    },
    async guarded(what, fn) {
      try {
        return await fn();
      } catch (err) {
        await api.recordError(what, err);
        return null;
      }
    },
  };
  return api;
}

/**
 * The durable incoming queue for one provider.
 * A text is stored once per (provider, key) whichever way it arrives (webhook, retry, the
 * missed-text check), processed with retries and backoff, and its payload cleared afterwards.
 *
 * enqueue(text, source): text = { key, id, from, to, body, at, meta }
 */
export function createInboundQueue({ db, provider, allowed = [], identify = async () => ({ contact: null, ambiguous: null }), onReceived = async () => {}, log = () => {}, now = () => Date.now() }) {
  let processing = null;

  async function enqueue(text, source) {
    const res = await db.query(
      `INSERT INTO sms_events (provider, message_key, source, payload) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, message_key) DO NOTHING RETURNING id`,
      [provider, String(text.key), source, JSON.stringify(text)],
    );
    return res.rows.length > 0;
  }

  async function processOne(ev) {
    const t = ev.payload || {};
    const to = normalizePhone(t.to);
    const from = normalizePhone(t.from);
    if (!from) return { status: 'ignored', reason: 'no sender number' };
    if (allowed.length && !allowed.includes(to)) return { status: 'ignored', reason: 'not one of our SMS numbers' };
    // Who is it in Launch27? Only for numbers we haven't seen (network call outside the
    // transaction). Someone Launch27 doesn't know becomes a new contact.
    const known = await contactsByIdentity(db, 'phone', from);
    const found = known.length ? { contact: null, ambiguous: null } : await identify(from);
    const res = await db.tx((q) =>
      ingestInbound(
        q,
        { channel: 'sms', from, to, body: t.body || '', external_id: `${provider}:sms:${ev.message_key}`, at: t.at || undefined, meta: { provider, ...(t.meta || {}) } },
        { lookup: found.contact, l27Shared: found.ambiguous, now: new Date(now()) },
      ),
    );
    await onReceived();
    return { status: 'done', conversation_id: res.conversationId };
  }

  async function processEvents() {
    if (processing) return processing;
    processing = (async () => {
      const due = (await db.query("SELECT * FROM sms_events WHERE provider = $1 AND status = 'pending' AND next_attempt_at <= $2 ORDER BY id LIMIT 25", [provider, new Date(now())])).rows;
      for (const ev of due) {
        try {
          const r = await processOne(ev);
          await db.query('UPDATE sms_events SET status = $2, conversation_id = $3, last_error = $4, payload = NULL, processed_at = now(), attempts = attempts + 1 WHERE id = $1', [ev.id, r.status, r.conversation_id ?? null, r.reason ?? null]);
        } catch (err) {
          const attempts = ev.attempts + 1;
          const failed = attempts >= MAX_EVENT_ATTEMPTS;
          const wait = Math.min(60, 2 ** attempts) * MIN; // 2, 4, 8 … up to 60 minutes
          await db.query('UPDATE sms_events SET attempts = $2, status = $3, next_attempt_at = $4, last_error = $5 WHERE id = $1', [ev.id, attempts, failed ? 'failed' : 'pending', new Date(now() + wait), sanitize(err)]);
          log(failed ? 'error' : 'warn', `sms (${provider}): could not process an incoming text`, { event: ev.id, attempts, error: sanitize(err) });
        }
      }
      return due.length;
    })().finally(() => {
      processing = null;
    });
    return processing;
  }

  async function counts() {
    const rows = (await db.query('SELECT status, count(*)::int AS n FROM sms_events WHERE provider = $1 GROUP BY status', [provider])).rows;
    return Object.fromEntries(rows.map((c) => [c.status, c.n]));
  }

  return { enqueue, processEvents, counts };
}

/**
 * One SMS connector for the inbox over several providers. Each business number belongs to one
 * provider; a reply goes out through the provider that owns the conversation's number.
 * providers: [{ name, connector, numbers: [E.164] }]
 */
export function createSmsRouter(providers) {
  const owner = new Map();
  for (const p of providers) for (const n of p.numbers) if (!owner.has(n)) owner.set(n, p);
  return {
    name: providers.map((p) => p.name).join('+'),
    providers: providers.map((p) => p.name),
    identities: [...owner.keys()],
    async send(message) {
      const from = normalizePhone(message.from);
      const p = from ? owner.get(from) : providers[0];
      if (!p) throw new Error(`${from} isn't one of our SMS numbers. Send from ${[...owner.keys()].join(', ')}.`);
      const res = await p.connector.send({ ...message, from: from || undefined });
      return { ...res, provider: p.name };
    },
  };
}
