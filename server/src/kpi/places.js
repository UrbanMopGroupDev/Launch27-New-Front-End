// Google reviews from Google's public listing data (Places API (New)), for when the Business
// Profile API is not available (docs/kpi.md). Read-only: an API key, Text Search to find the
// listing once, then one Place Details read a day.
//
// What Google gives: the listing's total review count and rating, and up to 5 reviews it picks
// as "most relevant" (not the newest). So:
//   - counts are exact: each day's rise in the total is that day's new reviews;
//   - stars are known for a new review only when Google includes it in those 5;
//   - history up to the dated Google Takeout export comes from the export (exact).
// Kept: review ids, dates and stars only. No names or comments.
import { localDate } from '../schedule/rules.js';
import { KPI_SOURCES } from './config.js';

const API = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 20_000;

export class PlacesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function explain(status, data) {
  const msg = data?.error?.message || `HTTP ${status}`;
  if (status === 403 && /not been used|disabled|SERVICE_DISABLED/i.test(msg)) return `Places API (New) is not turned on in the Google Cloud project of this API key: ${msg}`;
  if (status === 403 || status === 400 && /API key/i.test(msg)) return `Google refused the API key (${msg}). Check GOOGLE_PLACES_API_KEY and that billing is on for its project`;
  if (status === 429) return `Google's Places quota is used up for now (${msg})`;
  return `Google Places ${status}: ${msg}`;
}

/**
 * The review list the scorecard reads, rebuilt from the stored state each time:
 * the export's reviews, every live review Google has shown (with stars), and for each daily
 * check the rest of that day's rise in the total as reviews without stars. Reviews between the
 * export and the first check that Google never showed have no date: they count all time only.
 */
export function placesReviews(state, exp) {
  const expReviews = (exp?.reviews || []).map(([date, rating], i) => ({ id: `exp:${i + 1}`, date, rating }));
  const expTo = exp?.reviews_to || '0000-00-00';
  const seen = Object.values(state.seen || {}).filter((r) => r.date > expTo).sort((a, b) => (a.date < b.date ? -1 : 1));
  const checks = [...(state.checks || [])].sort((a, b) => (a.day < b.day ? -1 : 1));
  const out = [...expReviews, ...seen.map((r) => ({ id: r.id, date: r.date, rating: r.rating }))];
  let undated = 0;
  if (checks.length) {
    const first = checks[0];
    undated = Math.max(0, first.total - expReviews.length - seen.filter((r) => r.date <= first.day).length);
    for (let i = 1; i < checks.length; i++) {
      const prev = checks[i - 1];
      const cur = checks[i];
      const shown = seen.filter((r) => r.date > prev.day && r.date <= cur.day).length;
      for (let k = 0; k < Math.max(0, cur.total - prev.total - shown); k++) out.push({ id: `count:${cur.day}:${k + 1}`, date: cur.day, rating: null });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { reviews: out, undated };
}

/**
 * `places` is config.places ({ apiKey, placeId? }); `loadExport` gives the brand's dated export
 * ({ exported_on, reviews_to, reviews: [[date, stars]] }) or null.
 */
export function createGooglePlacesKpi({ db, places, brand, loadExport = () => null, fetchImpl = fetch, log = { info() {}, warn() {}, error() {} }, now = () => Date.now() }) {
  let running = null;
  let lastAttempt = 0;
  let lastError = null;
  let memo = null;
  const exp = () => (brand.googleExport ? loadExport(brand.googleExport) : null);

  async function call(method, path, { fields, body } = {}) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { 'x-goog-api-key': places.apiKey, 'x-goog-fieldmask': fields, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new PlacesError(res.status, explain(res.status, data));
    return data;
  }

  async function stored() {
    const row = (await db.query('SELECT taken_at, data FROM kpi_snapshots WHERE brand = $1 AND source = $2', [brand.key, 'google_places'])).rows[0];
    return row ? { taken_at: new Date(row.taken_at).toISOString(), ...row.data } : null;
  }
  async function logRun(status, rows, note) {
    await db
      .query(
        `INSERT INTO kpi_refresh_log (brand, source, refresh_day, status, row_count, note) VALUES ($1,'google_places',$2,$3,$4,$5)
         ON CONFLICT (brand, source, refresh_day) DO UPDATE SET status = EXCLUDED.status, row_count = EXCLUDED.row_count, note = EXCLUDED.note, finished_at = now()`,
        [brand.key, localDate(now()), status, rows, note],
      )
      .catch((err) => log.warn('kpi refresh log failed', { error: err.message }));
  }

  /** The listing's place id: GOOGLE_PLACES_PLACE_ID, the one found before, or a Text Search for the brand's listing. */
  async function placeId(prev) {
    if (places.placeId) return places.placeId;
    if (prev?.place_id) return prev.place_id;
    if (!brand.googlePlaceQuery) throw new PlacesError(409, 'Set GOOGLE_PLACES_PLACE_ID: this brand has no listing name to search for');
    const found = await call('POST', '/places:searchText', { fields: 'places.id,places.displayName,places.formattedAddress', body: { textQuery: brand.googlePlaceQuery, pageSize: 5 } });
    const list = found.places || [];
    const match = list.filter((p) => brand.googleLocation?.test(`${p.displayName?.text || ''} ${p.formattedAddress || ''}`) ?? true);
    if (match.length >= 1) return match[0].id;
    throw new PlacesError(404, `No Google listing found for "${brand.googlePlaceQuery}": set GOOGLE_PLACES_PLACE_ID`);
  }

  async function sync() {
    lastAttempt = now();
    try {
      const prev = (await stored()) || { seen: {}, checks: [] };
      const id = await placeId(prev);
      const p = await call('GET', `/places/${encodeURIComponent(id)}`, { fields: 'id,displayName,rating,userRatingCount,reviews' });
      const total = Number(p.userRatingCount);
      if (!Number.isFinite(total)) throw new PlacesError(502, 'Google sent no review count for the listing');
      const seen = { ...prev.seen };
      for (const r of p.reviews || []) {
        const at = Date.parse(r.publishTime || '');
        const rid = String(r.name || '').split('/').pop();
        if (!rid || !Number.isFinite(at) || !(r.rating >= 1 && r.rating <= 5)) continue;
        seen[rid] = { id: rid, date: localDate(at), rating: Math.round(r.rating) };
      }
      const today = localDate(now());
      const checks = (prev.checks || []).filter((c) => c.day !== today);
      checks.push({ day: today, total });
      const taken = new Date(now()).toISOString();
      const data = { place_id: p.id || id, title: p.displayName?.text || null, total, rating: Number(p.rating) || null, seen, checks };
      await db.query(
        `INSERT INTO kpi_snapshots (brand, source, taken_at, data) VALUES ($1,'google_places',$2,$3::jsonb)
         ON CONFLICT (brand, source) DO UPDATE SET taken_at = EXCLUDED.taken_at, data = EXCLUDED.data`,
        [brand.key, taken, JSON.stringify(data)],
      );
      memo = { taken_at: taken, ...data };
      lastError = null;
      await logRun('ok', total, `${total} reviews on Google, ${Object.keys(seen).length} seen with stars`);
      log.info('kpi google places refreshed', { total, seen: Object.keys(seen).length });
      return { total, rating: data.rating };
    } catch (err) {
      lastError = err.message;
      await logRun('failed', 0, String(err.message).slice(0, 300));
      log.error('kpi google places refresh failed', { error: err.message });
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
    async pull() {
      if (!memo) memo = await stored();
      const e = exp();
      if (!memo) {
        if (!e?.reviews?.length) return { refreshed_at: null, note: lastError || 'Google Places has not been read yet' };
        return { refreshed_at: `${e.exported_on}T12:00:00.000Z`, note: `Export of ${e.exported_on}, not live${lastError ? `. ${lastError}` : ''}`, static: true, reviews: e.reviews.map(([date, rating], i) => ({ id: i + 1, date, rating, reviewer: '', comment: '' })), reviewBaseline: { count: 0, avg: 0 }, reviewsExport: { exported_on: e.exported_on, reviews_to: e.reviews_to } };
      }
      const { reviews, undated } = placesReviews(memo, e);
      return {
        refreshed_at: memo.taken_at,
        note: lastError ? `last refresh failed: ${lastError}` : `Google public data: ${memo.total} reviews, ${memo.rating ?? '—'} ★`,
        reviews: reviews.map((r) => ({ ...r, reviewer: '', comment: '' })),
        // Reviews between the export and the first live read that Google never showed: counted all time, no date or stars.
        reviewBaseline: { count: undated, avg: null },
      };
    },
    job: {
      start,
      running: () => !!running,
      // Once a day (the day's rise in the total is that day's new reviews), at boot if never run,
      // at most every 30 minutes after a failure.
      async maybeRun() {
        if (running || now() - lastAttempt < 30 * 60_000) return;
        const s = memo || (await stored());
        if (!s || localDate(Date.parse(s.taken_at)) < localDate(now())) start();
      },
    },
    async status() {
      const s = memo || (await stored());
      return { source: 'places', total: s?.total ?? null, rating: s?.rating ?? null, title: s?.title || null, refreshed_at: s?.taken_at || null, error: lastError };
    },
  };
}
