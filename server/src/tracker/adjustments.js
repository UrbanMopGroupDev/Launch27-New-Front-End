// Cleaner Adjustment: Kustomer's sidebar form, here. Submit adds one row to the office's pay
// adjustments Google Sheet, in the sheet's own layout (read Nov 26, 2026):
//   A Cleaner's Name · B Adjustment Amount ($) · C Description/Reason (the category) ·
//   D Date and Time (the service date) · E Customer Name · F Net Impact ·
//   G Additional Details ("<category> -<date>T00:00:00.000Z - <reason>") · H Submitted By ·
//   K Address · L Approved By
// I (Rule Set), J (Invoice Description) and O are the sheet's own formulas, and M, N and P are
// payroll's: none of them is written. The sheet stays the record of truth, and its reader
// (src/reports/adjustments.js) is unchanged. Needs the Google service account shared on the
// sheet as Editor. Dev and QA never write to it: a submission there is only recorded.
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const b64 = (s) => Buffer.from(s).toString('base64url');
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

// The sheet's own wording (column C and column F).
export const ADJUSTMENT_CATEGORIES = [
  'Client-Initiated Last Min Cancellation',
  'Cleaner-Initiated Last Min Cancellation',
  'Waived',
  'No Show',
  'Late Arrival',
  'Last Minute Schedule Change (Filled by Scheduling)',
  'Parking Ticket',
  'Mileages',
  'Google Review',
  'Bonus',
  'Pay Correction',
  'Responsibility for Damages',
];
export const NET_IMPACTS = ['Addition', 'Deduction', 'Exception'];
export const REASON_MAX = 1024;

/** A calendar day as the number Google Sheets stores for a date (days since Dec 30, 1899). */
export function sheetSerial(day) {
  const m = DAY.exec(day);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 + 25569;
}

/** Checks the form. Returns the cleaned fields, or throws { status: 400 }. */
export function cleanAdjustment(body = {}, user = {}) {
  const text = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const f = {
    cleaner_name: text(body.cleaner_name),
    category: text(body.category),
    reason: String(body.reason ?? '').trim(),
    customer_name: text(body.customer_name),
    net_impact: text(body.net_impact),
    submitted_by: text(body.submitted_by) || text(user.name || user.email),
    approved_by: text(body.approved_by),
    customer_address: text(body.customer_address, 500),
    service_date: text(body.service_date),
  };
  const amount = Number(String(body.amount ?? '').replace(/[$,\s]/g, ''));
  if (!f.cleaner_name) throw fail(400, 'Cleaner Name is needed');
  if (String(body.amount ?? '').trim() === '' || !Number.isFinite(amount)) throw fail(400, 'Adjustment Amount must be a number');
  if (!ADJUSTMENT_CATEGORIES.includes(f.category)) throw fail(400, 'Pick a Category');
  if (!NET_IMPACTS.includes(f.net_impact)) throw fail(400, 'Pick a Net Impact');
  if (!DAY.test(f.service_date)) throw fail(400, 'Pick the Service Date');
  if (f.reason.length > REASON_MAX) throw fail(400, `Reason for Adjustment is too long (${REASON_MAX} characters at most)`);
  return { ...f, amount };
}

/** The cells one adjustment fills: A to H, then K and L. */
export function sheetCells(f) {
  return {
    main: [f.cleaner_name, f.amount, f.category, sheetSerial(f.service_date), f.customer_name, f.net_impact, `${f.category} -${f.service_date}T00:00:00.000Z - ${f.reason}`, f.submitted_by],
    tail: [f.customer_address, f.approved_by],
  };
}

export function createSheetWriter({ serviceAccount, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;
  let chain = Promise.resolve();
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
  async function call(method, url, body) {
    const res = await fetchImpl(url, { method, headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 || res.status === 404) throw fail(502, `Google refused: share the pay adjustments sheet with ${serviceAccount.client_email} as Editor`);
    if (!res.ok) throw fail(502, `Google Sheets ${res.status}: ${data.error?.message || 'request failed'}`);
    return data;
  }
  // The next row is the one after the last row with a cleaner's name in column A. (Not the
  // Sheets "append" call: the blank rows below the data hold formulas, so append would land
  // thousands of rows down.) One write at a time from this server.
  function addRow(sheetId, tab, cells) {
    const run = chain.then(async () => {
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values`;
      const colA = (await call('GET', `${base}/${encodeURIComponent(`${tab}!A:A`)}`)).values || [];
      const row = colA.length + 1;
      await call('POST', `${base}:batchUpdate`, {
        valueInputOption: 'RAW',
        data: [
          { range: `${tab}!A${row}:H${row}`, values: [cells.main] },
          { range: `${tab}!K${row}:L${row}`, values: [cells.tail] },
        ],
      });
      return row;
    });
    chain = run.catch(() => {});
    return run;
  }
  return { addRow };
}

export function createAdjustments({ db, config, fetchImpl = fetch, log = { info() {}, warn() {}, error() {} }, now = () => Date.now() }) {
  const sheet = config.paySheet || {};
  const isProd = config.appEnv === 'production';
  // Only production writes to the sheet, whatever else is set.
  const live = isProd && !!(sheet.id && sheet.serviceAccount);
  const tab = String(sheet.range || 'Sheet1!A2:I').split('!')[0];
  const writer = live ? createSheetWriter({ serviceAccount: sheet.serviceAccount, fetchImpl, now }) : null;

  function meta() {
    return {
      categories: ADJUSTMENT_CATEGORIES,
      net_impacts: NET_IMPACTS,
      reason_max: REASON_MAX,
      sheet_url: sheet.id ? `https://docs.google.com/spreadsheets/d/${sheet.id}/edit` : null,
      mode: live ? 'live' : isProd ? 'not_set_up' : 'sandbox',
    };
  }

  async function submit(user, body = {}) {
    const f = cleanAdjustment(body, user);
    const ids = [body.conversation_id, body.contact_id].map((v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null));
    const record = (outcome, row, error) =>
      db.query('INSERT INTO pay_adjustment_submissions (submitted_by, conversation_id, contact_id, fields, outcome, sheet_row, error) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)', [user.id, ids[0], ids[1], JSON.stringify(f), outcome, row, error ? String(error).slice(0, 500) : null]);
    if (!live) {
      if (isProd) throw fail(409, "The pay adjustments sheet isn't connected (PAY_ADJUSTMENTS_SHEET_ID and the Google service account)");
      await record('sandbox', null, null);
      return { outcome: 'sandbox', row: null, note: 'Test environment: recorded here, not sent to the sheet.' };
    }
    try {
      const row = await writer.addRow(sheet.id, tab, sheetCells(f));
      await record('sent', row, null);
      log.info('pay adjustment sent to the sheet', { row });
      return { outcome: 'sent', row };
    } catch (err) {
      await record('failed', null, err.message).catch(() => {});
      log.warn('pay adjustment not sent', { error: err.message });
      throw err.status ? err : fail(502, err.message);
    }
  }
  return { meta, submit };
}
