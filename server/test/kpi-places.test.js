// Google reviews from Google Places public data (src/kpi/places.js): exact counts, some stars.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { KPI_BRANDS } from '../src/kpi/config.js';
import { createKpi } from '../src/kpi/service.js';
import { createGooglePlacesKpi, placesReviews } from '../src/kpi/places.js';
import { createGoogleBusinessKpi } from '../src/kpi/google.js';
import { loadConfig } from '../src/config.js';

const brand = KPI_BRANDS[0];
const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
// A made-up export: 3 reviews up to Nov 12.
const exportData = { exported_on: '2026-11-17', reviews_to: '2026-11-12', reviews: [['2026-10-03', 5], ['2026-10-09', 4], ['2026-11-12', 5]] };
const loadExport = () => exportData;

// A made-up Google listing whose total and shown reviews change from day to day.
function fakePlaces() {
  const calls = [];
  const day = { total: 5, reviews: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push([opts.method, u.pathname, opts.headers['x-goog-fieldmask']]);
    assert.equal(opts.headers['x-goog-api-key'], 'k-test');
    if (u.pathname === '/v1/places:searchText') return json(200, { places: [{ id: 'P1', displayName: { text: 'UrbanMop Cleaning Services Ottawa' }, formattedAddress: 'Ottawa, ON' }] });
    if (u.pathname === '/v1/places/P1') return json(200, { id: 'P1', displayName: { text: 'UrbanMop Cleaning Services Ottawa' }, rating: 4.9, userRatingCount: day.total, reviews: day.reviews });
    return json(404, { error: { message: 'not found' } });
  };
  return { calls, fetchImpl, day };
}
const review = (id, iso, rating) => ({ name: `places/P1/reviews/${id}`, publishTime: iso, rating, authorAttribution: { displayName: 'Ada Example' }, text: { text: 'Great' } });

describe('Google reviews from Google Places public data', () => {
  test('rebuilding the list: export, shown reviews with stars, the rest of each day counted without stars', () => {
    const state = {
      seen: { a: { id: 'a', date: '2026-11-15', rating: 5 }, b: { id: 'b', date: '2026-11-21', rating: 3 }, old: { id: 'old', date: '2026-10-03', rating: 5 } },
      checks: [{ day: '2026-11-20', total: 5 }, { day: '2026-11-21', total: 7 }, { day: '2026-11-22', total: 7 }, { day: '2026-11-23', total: 8 }],
    };
    const { reviews, undated } = placesReviews(state, exportData);
    // First check: 5 on Google = 3 in the export + 'a' shown + 1 never shown (no date).
    assert.equal(undated, 1);
    assert.deepEqual(reviews.filter((r) => r.date > '2026-11-12').map((r) => [r.date, r.rating]), [['2026-11-15', 5], ['2026-11-21', 3], ['2026-11-21', null], ['2026-11-23', null]]);
    // Nothing from the export is counted twice.
    assert.equal(reviews.length, 7);
  });

  test('daily reads: counts exact, stars when Google shows them, no names kept, only reads', async () => {
    const db = await openDb({});
    const g = fakePlaces();
    let now = Date.parse('2026-11-28T15:00:00Z');
    const places = createGooglePlacesKpi({ db, places: { apiKey: 'k-test', placeId: null }, brand, loadExport, fetchImpl: g.fetchImpl, log: quiet, now: () => now });
    // Before the first read: the export, labelled.
    assert.ok((await places.pull()).reviewsExport);
    g.day.reviews = [review('r1', '2026-11-20T14:00:00Z', 4), review('old', '2026-10-03T14:00:00Z', 5)];
    assert.deepEqual(await places.job.start(), { total: 5, rating: 4.9 });
    assert.deepEqual(g.calls.map((c) => [c[0], c[1]]), [['POST', '/v1/places:searchText'], ['GET', '/v1/places/P1']]);
    let got = await places.pull();
    assert.equal(got.reviewsExport, undefined);
    assert.deepEqual(got.reviews.filter((r) => r.date > '2026-11-12').map((r) => [r.date, r.rating]), [['2026-11-20', 4]]);
    assert.deepEqual(got.reviewBaseline, { count: 1, avg: null });
    // Next day: 3 new on Google, one of them shown. The place id is not searched again.
    now += 86_400_000;
    g.day.total = 8;
    g.day.reviews = [review('r2', '2026-11-29T13:00:00Z', 2), review('r1', '2026-11-20T14:00:00Z', 4)];
    await places.job.start();
    assert.equal(g.calls.filter((c) => c[1] === '/v1/places:searchText').length, 1);
    got = await places.pull();
    assert.deepEqual(got.reviews.filter((r) => r.date > '2026-11-12').map((r) => [r.date, r.rating]), [['2026-11-20', 4], ['2026-11-29', 2], ['2026-11-29', null], ['2026-11-29', null]]);
    const snap = JSON.stringify((await db.query("SELECT data FROM kpi_snapshots WHERE source = 'google_places'")).rows[0].data);
    assert.ok(!snap.includes('Ada Example') && !snap.includes('Great'));

    // On the scorecard. All time: 8, matching Google (3 export + r1 + r2 + 2 counted + 1 undated).
    const config = { ...loadConfig({ APP_ENV: 'development' }), production: true };
    const launch27 = { key: 'launch27', label: 'Launch27', mode: 'live', pull: async () => ({ refreshed_at: new Date(now - 3_600_000).toISOString(), bookings: [] }) };
    const kpi = createKpi({ db, config, log: quiet, now: () => now, connectors: [launch27, places] });
    const card = await kpi.scorecard({ month: '2026-11' });
    const tile = card.tiles.find((t) => t.kpi === 'reviews');
    // Nov: export's Nov 12 (5★), r1 (4★), r2 (2★), 2 without stars.
    assert.equal(tile.value, 5);
    assert.match(tile.details.find((d) => d.label === 'Average rating').value, /^3\.67 ★ \(stars known for 3 of 5\)/);
    assert.match(tile.details.find((d) => d.label === 'All-time average').value, /^4\.00 ★ \(8 reviews\)/);
    assert.ok(tile.badges.some((b) => /stars are known for 3 of 5/.test(b.text)));
    assert.ok(!tile.badges.some((b) => /export/.test(b.text)));
    assert.deepEqual([card.google.configured, card.google.fallback.total], [false, 8]);
    await db.close();
  });

  test('a refused API key is said plainly and the export stays', async () => {
    const db = await openDb({});
    const fetchImpl = async () => json(403, { error: { message: 'Places API (New) has not been used in project 1 before or it is disabled.' } });
    const places = createGooglePlacesKpi({ db, places: { apiKey: 'k-test', placeId: 'P1' }, brand, loadExport, fetchImpl, log: quiet });
    assert.equal(await places.job.start(), null);
    assert.match((await places.status()).error, /Places API \(New\) is not turned on/);
    const got = await places.pull();
    assert.ok(got.reviewsExport && /not turned on/.test(got.note));
    await db.close();
  });

  test('behind the Business Profile connector: Places serves until the Business Profile API is read, and runs with it', async () => {
    const db = await openDb({});
    const g = fakePlaces();
    const now = Date.parse('2026-11-28T15:00:00Z');
    const places = createGooglePlacesKpi({ db, places: { apiKey: 'k-test', placeId: 'P1' }, brand, loadExport, fetchImpl: g.fetchImpl, log: quiet, now: () => now });
    // The Business Profile sign-in is refused (wrong project): Google answers 429 to every call.
    const refused = async () => json(429, { error: { message: 'Quota exceeded ... limit 0' } });
    const gbp = createGoogleBusinessKpi({ db, gbp: { clientId: 'c', clientSecret: 's', refreshToken: 'rt', location: null }, secret: SECRET, brand, fallback: places, fetchImpl: refused, log: quiet, now: () => now });
    await gbp.job.maybeRun();
    while (gbp.job.running()) await new Promise((r) => setTimeout(r, 5));
    const got = await gbp.pull({});
    assert.ok(/Google public data: 5 reviews/.test(got.note));
    assert.equal(got.reviewsExport, undefined);
    const st = await gbp.status();
    assert.equal(st.fallback.total, 5);
    assert.match(st.error, /Google Cloud project approved/);
    await db.close();
  });

  test('configuration: production only', () => {
    assert.equal(loadConfig({ APP_ENV: 'development', GOOGLE_PLACES_API_KEY: 'k' }).places, null);
  });
});
