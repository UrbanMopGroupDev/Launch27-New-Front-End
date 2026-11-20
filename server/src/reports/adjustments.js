// Pay adjustments sheet (Google Sheets, read-only): the office's record of late cancellations,
// no-shows, late arrivals and Google review bonuses per cleaner. Cleaner reports 2.0 reads its
// reliability and Google review numbers from here. The sheet is shared (Viewer) with the app's
// Google service account; nothing is ever written to it.
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const b64 = (s) => Buffer.from(s).toString('base64url');

export function createSheetReader({ serviceAccount, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;
  async function token() {
    if (cached && cached.exp > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: serviceAccount.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key).toString('base64url');
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(), signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`);
    cached = { token: body.access_token, exp: now() + 3_000_000 };
    return cached.token;
  }
  return {
    async values(sheetId, range) {
      const res = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`, { headers: { authorization: `Bearer ${await token()}`, accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 403 || res.status === 404) throw new Error(`The sheet isn't shared with ${serviceAccount.client_email} (share it as Viewer), or the Google Sheets API is off for that Google project`);
      if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${body.error?.message || 'request failed'}`);
      return body.values || [];
    },
  };
}

// ---------- parsing ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const ok = (y, m, d) => (y > 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

// The sheet's dates: 13/11/2026 (day first), 2024-07-14 04:00:00, 2026-11-13T00:00:00.000Z.
// Anything else ("January 29th", "Feb 2 booking") has no year, so it is left undated.
export function parseSheetDate(text) {
  const s = String(text || '').trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return ok(+m[3], +m[2], +m[1]);
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return ok(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

// What a row is, from its Description/Reason (and the deduction sign for the old wording).
export function adjustmentKind(reason, amount, impact) {
  const r = String(reason || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/no[- ]?show/.test(r)) return 'no_show';
  if (/client-initiated/.test(r)) return 'client_cancel';
  if (/cleaner-initiated/.test(r)) return 'late_cancel';
  if (/last min(ute)? cancel/.test(r)) return amount < 0 || /deduction/i.test(impact || '') ? 'late_cancel' : 'client_cancel';
  if (/late arrival/.test(r)) return 'late_arrival';
  if (/google review/.test(r)) return 'google_review';
  return 'other';
}

// Rows (after the header) -> adjustments. Columns: A cleaner, B amount, C reason, D date,
// E customer, F net impact, G details, H submitted by, I rule set (Valid / Invalid / blank).
export function parseAdjustmentRows(values) {
  const out = [];
  values.forEach((row, i) => {
    const [name, amt, reason, when, customer, impact, details, by, rule] = Array.from({ length: 9 }, (_, k) => String(row[k] ?? '').trim());
    if (!name) return;
    const amount = Number(String(amt).replace(/[^0-9.-]/g, '')) || 0;
    const kind = adjustmentKind(reason, amount, impact);
    if (kind === 'other' || kind === 'client_cancel') return;
    // The date column first; else the ISO date the form puts in the details.
    const date = parseSheetDate(when) || parseSheetDate(details) || parseSheetDate(reason);
    out.push({ row_no: i + 2, cleaner_name: name.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim(), kind, amount, on_date: date, customer: customer || null, details: details.slice(0, 300) || null, submitted_by: by || null, valid: !/^invalid$/i.test(rule) });
  });
  return out;
}

// ---------- matching sheet names to Launch27 cleaners ----------
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

// cleaners: [{ id, name }]. Returns name -> id for exact names, then a unique first + last
// name, then a first name only one cleaner has. Anything ambiguous stays unmatched.
export function nameMatcher(cleaners) {
  const list = cleaners.map((c) => ({ id: c.id, n: norm(c.name), parts: norm(c.name).split(' ') })).filter((c) => c.n);
  const cache = new Map();
  return (raw) => {
    const n = norm(raw);
    if (!n) return null;
    if (cache.has(n)) return cache.get(n);
    const parts = n.split(' ');
    let hits = list.filter((c) => c.n === n);
    if (hits.length !== 1) hits = list.filter((c) => parts.every((p) => c.parts.includes(p)));
    if (hits.length !== 1 && parts.length > 1) hits = list.filter((c) => c.parts[0] === parts[0] && c.parts.at(-1) === parts.at(-1));
    if (hits.length !== 1 && parts.length > 1) hits = list.filter((c) => c.parts.every((p) => parts.includes(p)));
    const id = hits.length === 1 ? hits[0].id : null;
    cache.set(n, id);
    return id;
  };
}
