// Live Google reviews (src/kpi/google.js): connecting, reading, and what the scorecard shows.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { KPI_BRANDS } from '../src/kpi/config.js';
import { createKpi } from '../src/kpi/service.js';
import { createGoogleBusinessKpi, makeState, checkState, sealToken, openToken, GBP_SCOPE } from '../src/kpi/google.js';
import { createGoogleExportKpi } from '../src/kpi/live.js';
import { loadConfig } from '../src/config.js';

const NOW = Date.parse('2026-11-19T15:00:00Z');
const SECRET = 'x'.repeat(40);
const brand = KPI_BRANDS[0];
const quiet = { info() {}, warn() {}, error() {} };
const gbp = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret', refreshToken: null, location: null };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const idToken = (email) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;

// A made-up Google: two listings (Ottawa and another city), three pages of reviews.
function fakeGoogle({ reviewsStatus = 200, scope = `openid email ${GBP_SCOPE}` } = {}) {
  const calls = [];
  const reviews = [
    { reviewId: 'r1', starRating: 'FIVE', createTime: '2026-10-03T14:00:00Z', reviewer: { displayName: 'Ada Example' }, comment: 'Great' },
    { reviewId: 'r2', starRating: 'FOUR', createTime: '2026-10-09T14:00:00Z' },
    { reviewId: 'r3', starRating: 'THREE', createTime: '2026-10-20T14:00:00Z' },
    { reviewId: 'r4', starRating: 'STAR_RATING_UNSPECIFIED', createTime: '2026-10-21T14:00:00Z' },
    { reviewId: 'r5', starRating: 'ONE', createTime: '2026-11-01T03:30:00Z' }, // Oct 31 in Ottawa
    { reviewId: 'r6', starRating: 'FIVE', createTime: '2025-01-05T14:00:00Z' },
  ];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push([opts.method || 'GET', u.origin + u.pathname, opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : null]);
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      const p = Object.fromEntries(new URLSearchParams(opts.body));
      if (p.grant_type === 'authorization_code') return p.code === 'good' ? json(200, { access_token: 'at1', expires_in: 3600, refresh_token: 'rt-secret', scope, id_token: idToken('info@example.com') }) : json(400, { error: 'invalid_grant' });
      return p.refresh_token === 'rt-secret' ? json(200, { access_token: 'at2', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    assert.equal(opts.method, 'GET');
    if (u.pathname === '/v1/accounts') return json(200, { accounts: [{ name: 'accounts/1' }] });
    if (u.pathname === '/v1/accounts/1/locations') return json(200, { locations: [{ name: 'locations/7', title: 'UrbanMop Cleaning Services Ottawa', storefrontAddress: { locality: 'Ottawa' } }, { name: 'locations/8', title: 'Somewhere Else', storefrontAddress: { locality: 'Cornwall' } }] });
    if (u.pathname === '/v4/accounts/1/locations/7/reviews') {
      if (reviewsStatus !== 200) return json(reviewsStatus, { error: { message: "Quota exceeded for quota metric 'Requests' ... limit 0" } });
      const page = Number(u.searchParams.get('pageToken') || 0);
      const slice = reviews.slice(page * 2, page * 2 + 2);
      return json(200, { reviews: slice, totalReviewCount: 6, averageRating: 3.8, nextPageToken: page * 2 + 2 < reviews.length ? String(page + 1) : undefined });
    }
    return json(404, { error: { message: 'not found' } });
  };
  return { calls, fetchImpl };
}

describe('Google reviews, live (Business Profile API)', () => {
  test('state and token sealing', () => {
    const s = makeState(SECRET, 5, NOW);
    assert.equal(checkState(SECRET, s, 5, NOW + 60_000), true);
    assert.equal(checkState(SECRET, s, 6, NOW), false); // another person
    assert.equal(checkState(SECRET, s, 5, NOW + 16 * 60_000), false); // expired
    assert.equal(checkState(SECRET, `${s}x`, 5, NOW), false);
    assert.equal(checkState('y'.repeat(40), s, 5, NOW), false);
    const sealed = sealToken(SECRET, 'rt-secret');
    assert.ok(!sealed.includes('rt-secret'));
    assert.equal(openToken(SECRET, sealed), 'rt-secret');
  });

  test('connect, read every page, keep dates and stars only, and the tile is live', async () => {
    const db = await openDb({});
    const g = fakeGoogle();
    const google = createGoogleBusinessKpi({ db, gbp, secret: SECRET, brand, fallback: createGoogleExportKpi({ brand }), fetchImpl: g.fetchImpl, log: quiet, now: () => NOW });
    // Before connecting: the dated export, with the reason.
    const before = await google.pull({});
    assert.ok(before.reviewsExport && /not connected/.test(before.note));
    assert.equal((await google.status()).connected, false);
    await google.job.maybeRun();
    assert.equal(g.calls.length, 0); // nothing is tried before it is connected

    const url = new URL(google.connectUrl({ redirectUri: 'https://portal.example/api/kpi/google/callback', userId: 3 }));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.deepEqual([url.searchParams.get('access_type'), url.searchParams.get('prompt'), url.searchParams.get('scope')], ['offline', 'consent', `openid email ${GBP_SCOPE}`]);
    await assert.rejects(google.finishConnect({ code: 'good', state: url.searchParams.get('state'), redirectUri: 'x', userId: 4 }), /expired/);
    assert.deepEqual(await google.finishConnect({ code: 'good', state: url.searchParams.get('state'), redirectUri: 'https://portal.example/api/kpi/google/callback', userId: 3, userEmail: 'boss@example.com' }), { email: 'info@example.com' });
    const row = (await db.query('SELECT refresh_token, google_email, connected_by FROM kpi_google_auth')).rows[0];
    assert.ok(!row.refresh_token.includes('rt-secret'));
    assert.deepEqual([row.google_email, row.connected_by], ['info@example.com', 'boss@example.com']);

    assert.deepEqual(await google.job.start(), { reviews: 5, location: 'accounts/1/locations/7' });
    // Only GETs went to the Business Profile APIs; the token endpoint is the only POST.
    assert.ok(g.calls.filter((c) => c[0] !== 'GET').every((c) => c[1] === 'https://oauth2.googleapis.com/token'));
    const got = await google.pull({});
    assert.equal(got.reviewsExport, undefined);
    assert.deepEqual(got.reviews.map((r) => [r.date, r.rating]), [['2025-01-05', 5], ['2026-10-03', 5], ['2026-10-09', 4], ['2026-10-20', 3], ['2026-10-31', 1]]);
    assert.ok(got.reviews.every((r) => r.reviewer === '' && r.comment === ''));
    const snap = JSON.stringify((await db.query("SELECT data FROM kpi_snapshots WHERE source = 'google'")).rows[0].data);
    assert.ok(!snap.includes('Ada Example') && !snap.includes('Great'));
    const st = await google.status();
    assert.deepEqual([st.connected, st.email, st.location, st.total, st.average], [true, 'info@example.com', 'UrbanMop Cleaning Services Ottawa', 6, 3.8]);

    // On the scorecard: October has 4 reviews, no export badge.
    const config = { ...loadConfig({ APP_ENV: 'development' }), production: true };
    // The tile also reads completed visits from Launch27: a fresh, empty Launch27 here.
    const launch27 = { key: 'launch27', label: 'Launch27', mode: 'live', pull: async () => ({ refreshed_at: new Date(NOW - 3_600_000).toISOString(), bookings: [] }) };
    const kpi = createKpi({ db, config, log: quiet, now: () => NOW, connectors: [launch27, google] });
    const card = await kpi.scorecard({ month: '2026-10' });
    const tile = card.tiles.find((t) => t.kpi === 'reviews');
    assert.equal(tile.value, 4);
    assert.ok(!tile.badges.some((x) => /export/.test(x.text)));
    assert.equal(card.google.connected, true);
    // Once a day: a second run today is skipped.
    const n = g.calls.length;
    await google.job.maybeRun();
    assert.equal(g.calls.length, n);
    // Disconnect forgets the sign-in; the last snapshot stays.
    await kpi.googleDisconnect();
    assert.equal((await google.status()).connected, false);
    await db.close();
  });

  test('a project that is not the approved one is explained, and the last snapshot stays', async () => {
    const db = await openDb({});
    const g = fakeGoogle({ reviewsStatus: 429 });
    const google = createGoogleBusinessKpi({ db, gbp: { ...gbp, refreshToken: 'rt-secret' }, secret: SECRET, brand, fetchImpl: g.fetchImpl, log: quiet, now: () => NOW });
    assert.equal(await google.job.start(), null);
    const st = await google.status();
    assert.match(st.error, /Google Cloud project approved for the Business Profile API/);
    assert.equal((await google.pull({})).refreshed_at, null);
    assert.deepEqual((await db.query("SELECT status FROM kpi_refresh_log WHERE source = 'google'")).rows, [{ status: 'failed' }]);
    await db.close();
  });

  test('Google refusing the Business Profile box, or no lasting sign-in, is said plainly', async () => {
    const db = await openDb({});
    const g = fakeGoogle({ scope: 'openid email' });
    const google = createGoogleBusinessKpi({ db, gbp, secret: SECRET, brand, fetchImpl: g.fetchImpl, log: quiet, now: () => NOW });
    const state = makeState(SECRET, 1, NOW);
    await assert.rejects(google.finishConnect({ code: 'good', state, redirectUri: 'r', userId: 1 }), /tick the box/);
    await assert.rejects(google.finishConnect({ code: 'bad', state, redirectUri: 'r', userId: 1 }), /connect Google again/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kpi_google_auth')).rows[0].n, 0);
    await db.close();
  });

  test('configuration: production only, both client values needed', () => {
    assert.equal(loadConfig({ APP_ENV: 'development', GBP_CLIENT_ID: 'a', GBP_CLIENT_SECRET: 'b' }).gbp, null);
  });
});
