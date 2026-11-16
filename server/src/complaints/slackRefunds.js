// Parse a #finance-refunds / #finance-operations-collaboration post into a refund record:
// client name, % and $ amount, service date, why, and any share charged back to the cleaner.
// Written against the real posting styles (2024–2026), e.g.
//   "please process 40% ($203.71) refund for Alissa B…, service date August 7th due to dissatisfaction"
//   "Refunded Omar S… for 50% - $182.01 due to unsatisfactory with the service"
//   "Refunded G… M… for $197.75 for the repair of the sculpture. Deducted the half amount ($98.88) to Amy."
//   "full refund of $401.04 for V… T… for her cancelled booking"  (not a complaint)
// Pure: no I/O. Unparseable posts come back with kind 'unparsed' so a person can check them.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NOT_NAMES = new Set(['the', 'her', 'his', 'their', 'client', 'service', 'booking', 'appointment', 'date', 'refund', 'full', 'amount', 'dissatisfaction', 'unsatisfactory', 'derek', 'jose', 'vincent', 'moi', 'bashar', 'leslie', 'fyi', 'hi', 'hello', 'thanks', 'thank', 'please', 'recent', 'previous', 'negative']);

const money = (s) => {
  const n = Number(String(s).replace(/[,$*\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

export function cleanSlackText(text) {
  return String(text || '')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<https?:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[A-Z0-9]+>/g, '@someone')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clientName(t) {
  const pats = [
    /\b[Rr]efunded\s+(?:client\s+)?([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,2})/u,
    /\b(?:for|to)\s+(?:[Cc]lient\s+|the client\s+)?([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,2})(?=\s*(?:,|\.|-|–|\(|for\b|due\b|regarding\b|on\b|service\b|date\b|\||$))/u,
    /\b[Cc]lient(?:'s name is|:)?\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,2})/u,
  ];
  for (const re of pats) {
    for (const m of t.matchAll(new RegExp(re.source, 'gu'))) {
      const words = m[1].split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase()) && !new RegExp(`^${MONTH_RE}$`, 'i').test(w));
      if (words.length) return words.join(' ');
    }
  }
  return null;
}

function serviceDate(t, postedAt) {
  const m = t.match(new RegExp(`${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d\\d))?`, 'i'));
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const day = Number(m[2]);
  const posted = new Date(postedAt);
  let year = m[3] ? Number(m[3]) : posted.getUTCFullYear();
  // No year written: the most recent such date on or before the post.
  if (!m[3] && Date.UTC(year, month, day) > posted.getTime() + 86_400_000) year -= 1;
  const d = new Date(Date.UTC(year, month, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function reasonKind(t) {
  if (/\b(cancel+ed|cancellation)\b/i.test(t) && !/dissatisf|unsatisf|complain/i.test(t)) return 'cancellation';
  if (/\b(affirm|difference of the amount|overpa(id|yment)|double charg|charged twice|duplicate)\b/i.test(t)) return 'billing_adjustment';
  if (/\b(damag|repair|broke|broken|replace(ment)?|reimburse)/i.test(t)) return 'damage';
  if (/\b(dissatisf|unsatisf|complain|negative|not happy|unhappy|missed|poor|condition of the property|review|experience)/i.test(t)) return 'complaint';
  return 'unknown';
}

/**
 * @param {{text: string, ts: string, user_name?: string}} msg  Slack message (ts in seconds)
 * @returns {null | {kind, client_name, pct, amount, service_date, reason, cleaner_recovery, review_related, decided_by, approved_by, posted_at}}
 */
export function parseRefundPost(msg) {
  const t = cleanSlackText(msg.text);
  if (!/\b(refund|reimburse|e-?transfer)/i.test(t)) return null;
  if (/has (joined|left) the channel/i.test(t)) return null;
  const postedAt = new Date(Number(msg.ts) * 1000).toISOString();
  // A question about an earlier refund ("could you confirm if the refund … was due to …")
  // isn't a new refund; keep it as context only.
  const isQuestion = /\b(could|can) you (kindly )?confirm\b/i.test(t);

  const full = /\bfull (refund|amount)\b/i.test(t);
  const pctM = t.match(/\b(\d{1,3}(?:\.\d+)?)\s?%/);
  let pct = full ? 100 : pctM ? Number(pctM[1]) : null;
  // Amount: "$203.71", "(… $95.2)", or "50% -252.17" (no $ sign).
  const dollar = [...t.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)].map((m) => money(m[1]));
  let amount = dollar[0] ?? null;
  if (amount == null && pctM) {
    const after = t.slice(t.indexOf(pctM[0]) + pctM[0].length).match(/^\s*[-–(]?\s*(\d+(?:\.\d{1,2})?)/);
    if (after) amount = money(after[1]);
  }
  // Cleaner's share of a damage claim: "deduct 50% of the amount" / "Deducted the half amount ($98.88)".
  let cleaner_recovery = null;
  const ded = t.match(/\bdeduct(?:ed|ing)?\b(.{0,80})/i);
  if (ded) {
    const d$ = ded[1].match(/\$\s?(\d+(?:\.\d{1,2})?)/);
    const dPct = ded[1].match(/(\d{1,3})\s?%/);
    if (d$) cleaner_recovery = money(d$[1]);
    else if (/half/i.test(ded[1]) && amount) cleaner_recovery = Math.round(amount * 50) / 100;
    else if (dPct && amount) cleaner_recovery = Math.round(amount * Number(dPct[1])) / 100;
    // "deduct 50%" means pct above described the cleaner deduction, not the refund.
    if (dPct && pctM && dPct[1] === pctM[1] && !full) pct = null;
  }
  const kind = isQuestion ? 'question' : reasonKind(t);
  const author = msg.user_name || null;
  const approvedByDerek = /\bderek\b.{0,40}\bapprov|approv.{0,40}\bderek\b/i.test(t) || /^derek/i.test(author || '');
  const parsed = {
    kind,
    client_name: clientName(t),
    pct,
    amount,
    service_date: serviceDate(t, postedAt),
    reason: (t.match(/\b(?:due to|for the|regarding|because of)\s+([^.|]{3,120})/i)?.[1] || '').trim() || null,
    cleaner_recovery,
    review_related: /\b(google )?review\b/i.test(t),
    decided_by: author,
    approved_by: approvedByDerek ? 'Derek Chiu' : /\b(fyi|processed|refunded)\b/i.test(t) ? author : null,
    posted_at: postedAt,
  };
  if (!parsed.client_name || (parsed.amount == null && parsed.pct == null)) parsed.kind = isQuestion ? 'question' : 'unparsed';
  return parsed;
}
