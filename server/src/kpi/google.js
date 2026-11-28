// Google reviews, live, from the Google Business Profile API (docs/kpi.md). Read-only: the only
// scope asked for is business.manage, which Google requires even to read reviews, and the only
// calls made are GETs. Nothing is replied to, flagged or changed on the listing.
//
// Sign-in: a person who manages the listing (info@urbanmop.ca) clicks "Connect Google" on the
// KPI page once. Google returns a refresh token, which is kept sealed (AES-256-GCM, keyed from
// SESSION_SECRET) in kpi_google_auth. GBP_REFRESH_TOKEN in the environment works instead.
// The OAuth client (GBP_CLIENT_ID / GBP_CLIENT_SECRET) must belong to the Google Cloud project
// Google approved for the Business Profile API: any other project gets a quota of 0.
//
// Kept per review: its id, date and star rating. No reviewer names or comments.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { localDate } from '../schedule/rules.js';
import { KPI_SOURCES } from './config.js';

export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCOUNTS = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const REVIEWS = 'https://mybusiness.googleapis.com/v4';
const TIMEOUT_MS = 20_000;
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const STATE_TTL_MS = 15 * 60_000;

export class GbpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- sealing the refresh token ----------
function keyOf(secret) {
  return createHash('sha256').update(`kpi-google:${secret}`).digest();
}
export function sealToken(secret, text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
export function openToken(secret, sealed) {
  const b = Buffer.from(String(sealed), 'base64');
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---------- the OAuth state: signed, tied to the person, short-lived ----------
export function makeState(secret, userId, at = Date.now()) {
  const body = `${userId}.${at}.${randomBytes(8).toString('hex')}`;
  return `${body}.${createHmac('sha256', keyOf(secret)).update(body).digest('base64url')}`;
}
export function checkState(secret, state, userId, at = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4) return false;
  const body = parts.slice(0, 3).join('.');
  const want = Buffer.from(createHmac('sha256', keyOf(secret)).update(body).digest('base64url'));
  const got = Buffer.from(parts[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  return parts[0] === String(userId) && at - Number(parts[1]) >= 0 && at - Number(parts[1]) < STATE_TTL_MS;
}

/** The email in an id_token from Google's token endpoint (received directly over TLS, so not re-verified). */
const emailOf = (idToken) => {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
};

/** A Google API error, put plainly. Quota 0 means the client's project is not the approved one. */
function explain(status, data) {
  const msg = data?.error?.message || data?.error_description || data?.error || `HTTP ${status}`;
  if (status === 429 || /quota/i.test(msg)) return `Google refused (${msg}). The OAuth client must be in the Google Cloud project approved for the Business Profile API`;
  if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) return `A Business Profile API is not turned on in the Google Cloud project: ${msg}`;
  if (status === 403) return `Google refused (${msg}). The connected Google account must be an owner or manager of the listing`;
  if (data?.error === 'invalid_grant') return 'The Google sign-in has expired or was revoked: connect Google again';
  return `Google ${status}: ${msg}`;
}

/**
 * Live Google reviews connector for one brand. `gbp` is config.gbp ({ clientId, clientSecret,
 * refreshToken?, location? }); `fallback` (the dated export) serves until the first sync.
 */
export function createGoogleBusinessKpi({ db, gbp, secret, brand, fallback = null, fetchImpl = fetch, log = { info() {}, warn() {}, error() {} }, now = () => Date.now() }) {
  let running = null;
  let lastAttempt = 0;
  let lastError = null;
  let memo = null;
  let access = null; // { token, exp }

  async function auth() {
    const row = (await db.query('SELECT refresh_token, google_email, connected_by, connected_at FROM kpi_google_auth WHERE brand = $1', [brand.key])).rows[0];
    if (row) return { refreshToken: openToken(secret, row.refresh_token), email: row.google_email, by: row.connected_by, at: row.connected_at };
    if (gbp.refreshToken) return { refreshToken: gbp.refreshToken, email: null, by: 'GBP_REFRESH_TOKEN', at: null };
    return null;
  }

  async function post(params) {
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GbpError(res.status, explain(res.status, body));
    return body;
  }

  async function token() {
    if (access && access.exp > now()) return access.token;
    const a = await auth();
    if (!a) throw new GbpError(409, 'Google is not connected yet');
    const body = await post({ grant_type: 'refresh_token', client_id: gbp.clientId, client_secret: gbp.clientSecret, refresh_token: a.refreshToken });
    access = { token: body.access_token, exp: now() + (Number(body.expires_in) || 3600) * 1000 - 60_000 };
    return access.token;
  }

  async function get(url) {
    const res = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${await token()}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401) access = null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GbpError(res.status, explain(res.status, data));
    return data;
  }

  /** "accounts/1/locations/2" for this brand: GBP_LOCATION, or the one listing whose name matches the brand. */
  async function findLocation() {
    if (gbp.location) return { name: gbp.location, title: null };
    const found = [];
    let pageToken;
    do {
      const page = await get(`${ACCOUNTS}?${new URLSearchParams({ pageSize: '20', ...(pageToken ? { pageToken } : {}) })}`);
      for (const acc of page.accounts || []) {
        let lt;
        do {
          const locs = await get(`${INFO}/${acc.name}/locations?${new URLSearchParams({ readMask: 'name,title,storefrontAddress', pageSize: '100', ...(lt ? { pageToken: lt } : {}) })}`);
          for (const l of locs.locations || []) found.push({ name: `${acc.name}/${l.name}`, title: l.title || '', city: l.storefrontAddress?.locality || '' });
          lt = locs.nextPageToken;
        } while (lt);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    const unique = [...new Map(found.map((l) => [l.name.split('/').slice(-2).join('/'), l])).values()];
    const match = brand.googleLocation ? unique.filter((l) => brand.googleLocation.test(`${l.title} ${l.city}`)) : unique;
    if (match.length === 1) return match[0];
    if (!unique.length) throw new GbpError(404, 'The connected Google account manages no Business Profile listings');
    throw new GbpError(409, `More than one listing could be this brand: set GBP_LOCATION to one of ${unique.map((l) => `${l.name} (${l.title}${l.city ? `, ${l.city}` : ''})`).join('; ')}`);
  }

  async function stored() {
    const row = (await db.query('SELECT taken_at, data FROM kpi_snapshots WHERE brand = $1 AND source = $2', [brand.key, 'google'])).rows[0];
    return row ? { taken_at: new Date(row.taken_at).toISOString(), ...row.data } : null;
  }
  async function logRun(status, rows, note) {
    await db
      .query(
        `INSERT INTO kpi_refresh_log (brand, source, refresh_day, status, row_count, note) VALUES ($1,'google',$2,$3,$4,$5)
         ON CONFLICT (brand, source, refresh_day) DO UPDATE SET status = EXCLUDED.status, row_count = EXCLUDED.row_count, note = EXCLUDED.note, finished_at = now()`,
        [brand.key, localDate(now()), status, rows, note],
      )
      .catch((err) => log.warn('kpi refresh log failed', { error: err.message }));
  }

  async function sync() {
    lastAttempt = now();
    try {
      const loc = await findLocation();
      const reviews = [];
      let summary = null;
      let pageToken;
      do {
        const page = await get(`${REVIEWS}/${loc.name}/reviews?${new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc', ...(pageToken ? { pageToken } : {}) })}`);
        summary = summary || { total: Number(page.totalReviewCount) || 0, average: Number(page.averageRating) || null };
        for (const r of page.reviews || []) {
          const rating = STARS[r.starRating];
          if (!rating || !r.createTime) continue; // no rating: nothing to count
          reviews.push({ id: String(r.reviewId || r.name || reviews.length), date: localDate(Date.parse(r.createTime)), rating });
        }
        pageToken = page.nextPageToken;
      } while (pageToken && reviews.length < 20_000);
      reviews.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const taken = new Date(now()).toISOString();
      const data = { location: loc.name, title: loc.title, reviews, total: summary?.total ?? reviews.length, average: summary?.average ?? null };
      await db.query(
        `INSERT INTO kpi_snapshots (brand, source, taken_at, data) VALUES ($1,'google',$2,$3::jsonb)
         ON CONFLICT (brand, source) DO UPDATE SET taken_at = EXCLUDED.taken_at, data = EXCLUDED.data`,
        [brand.key, taken, JSON.stringify(data)],
      );
      memo = { taken_at: taken, ...data };
      lastError = null;
      await logRun('ok', reviews.length, `${reviews.length} reviews from ${loc.name}`);
      log.info('kpi google refreshed', { reviews: reviews.length, location: loc.name });
      return { reviews: reviews.length, location: loc.name };
    } catch (err) {
      lastError = err.message;
      await logRun(err.status === 409 && /not connected/.test(err.message) ? 'missing' : 'failed', 0, String(err.message).slice(0, 300));
      log.error('kpi google refresh failed', { error: err.message });
      throw err;
    }
  }
  const start = () => {
    if (!running) running = sync().catch(() => null).finally(() => (running = null));
    return running;
  };

  return {
    key: 'google',
    label: KPI_SOURCES.google.label,
    mode: 'live',
    async pull(opts) {
      if (!memo) memo = await stored();
      if (memo) {
        return {
          refreshed_at: memo.taken_at,
          note: lastError ? `last refresh failed: ${lastError}` : null,
          reviews: memo.reviews.map((r) => ({ id: r.id, date: r.date, rating: r.rating, reviewer: '', comment: '' })),
          reviewBaseline: { count: 0, avg: 0 },
        };
      }
      // Not synced yet: the fallback (Google Places public data, or the dated export) until the first live refresh.
      const exp = fallback ? await fallback.pull(opts) : { refreshed_at: null };
      const why = lastError || ((await auth().catch(() => null)) ? null : 'Google is not connected yet');
      return exp.refreshed_at ? { ...exp, note: `${exp.note}${why ? `. ${why}` : ''}` } : { refreshed_at: null, note: why || 'Google has not been read yet' };
    },
    job: {
      // The fallback (Google Places public data) keeps its own daily read until this one has data.
      start: (opts) => {
        if (fallback?.job && !memo) fallback.job.start(opts);
        return start();
      },
      running: () => !!running || !!fallback?.job?.running(),
      // Once a day, at boot if never run, at most every 30 minutes after a failure; never before it is connected.
      async maybeRun() {
        if (fallback?.job && !(memo || (await stored()))) await fallback.job.maybeRun();
        if (running || now() - lastAttempt < 30 * 60_000) return;
        if (!(await auth().catch(() => null))) return;
        const s = memo || (await stored());
        if (!s || localDate(Date.parse(s.taken_at)) < localDate(now())) start();
      },
    },
    // ---------- connecting ----------
    async status() {
      const a = await auth().catch(() => null);
      const s = memo || (await stored());
      return { configured: true, connected: !!a, email: a?.email || null, connected_at: a?.at ? new Date(a.at).toISOString() : null, location: s?.title || s?.location || null, total: s?.total ?? null, average: s?.average ?? null, error: lastError, fallback: !s && fallback?.status ? await fallback.status() : null };
    },
    connectUrl({ redirectUri, userId }) {
      const p = new URLSearchParams({ client_id: gbp.clientId, redirect_uri: redirectUri, response_type: 'code', scope: `openid email ${GBP_SCOPE}`, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: makeState(secret, userId, now()) });
      return `${AUTH_URL}?${p}`;
    },
    async finishConnect({ code, state, redirectUri, userId, userEmail }) {
      if (!checkState(secret, state, userId, now())) throw new GbpError(400, 'This Google sign-in link has expired: try Connect Google again');
      const body = await post({ grant_type: 'authorization_code', code: String(code || ''), client_id: gbp.clientId, client_secret: gbp.clientSecret, redirect_uri: redirectUri });
      if (!String(body.scope || '').includes(GBP_SCOPE)) throw new GbpError(400, 'Google did not allow access to the Business Profile: tick the box for it when signing in');
      if (!body.refresh_token) throw new GbpError(400, 'Google sent no lasting sign-in: remove this app at myaccount.google.com/permissions and connect again');
      const email = emailOf(body.id_token);
      await db.query(
        `INSERT INTO kpi_google_auth (brand, refresh_token, google_email, connected_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (brand) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, google_email = EXCLUDED.google_email, connected_by = EXCLUDED.connected_by, connected_at = now()`,
        [brand.key, sealToken(secret, body.refresh_token), email, userEmail || null],
      );
      access = { token: body.access_token, exp: now() + (Number(body.expires_in) || 3600) * 1000 - 60_000 };
      lastError = null;
      lastAttempt = 0;
      start();
      return { email };
    },
    async disconnect() {
      await db.query('DELETE FROM kpi_google_auth WHERE brand = $1', [brand.key]);
      access = null;
      return { connected: false };
    },
  };
}
