// Cleaner availability changed from the portal (docs/availability.md): the checks, what Launch27 is
// sent, the visits a change leaves outside the cleaner's hours, and the save through the planner.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkChanges, dateRange, toRows, visitsAffected, createAvailabilityHistory } from '../src/schedule/availability.js';
import { createSchedule } from '../src/schedule/service.js';
import { createWriteLog } from '../src/writes.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-11-02T14:00:00Z'); // Mon Nov 2, 9 am Toronto
const weekly = [1, 2, 3, 4, 5].map((d) => ({ weekday: d, dayoff: false, start_time: '08:00', end_time: '17:00' }));

describe('availability: checks and rows', () => {
  test('checkChanges keeps today to a year ahead, each date once, valid times', () => {
    assert.deepEqual(checkChanges([{ date: '2026-11-03', dayoff: true }], '2026-11-02'), [{ date: '2026-11-03', dayoff: true }]);
    assert.deepEqual(checkChanges([{ date: '2026-11-03', start_time: '09:00', end_time: '13:00' }], '2026-11-02'), [{ date: '2026-11-03', start_time: '09:00', end_time: '13:00' }]);
    assert.throws(() => checkChanges([{ date: '2026-11-01', dayoff: true }], '2026-11-02'), /past/);
    assert.throws(() => checkChanges([{ date: '2028-01-01', dayoff: true }], '2026-11-02'), /year/);
    assert.throws(() => checkChanges([{ date: '2026-11-03', dayoff: true }, { date: '2026-11-03', usual: true }], '2026-11-02'), /twice/);
    assert.throws(() => checkChanges([{ date: '2026-11-03', start_time: '13:00', end_time: '09:00' }], '2026-11-02'), /after the start/);
    assert.throws(() => checkChanges([], '2026-11-02'), /which dates/);
  });
  test('dateRange lists the days and caps the span', () => {
    assert.deepEqual(dateRange('2026-11-03', '2026-11-05'), ['2026-11-03', '2026-11-04', '2026-11-05']);
    assert.throws(() => dateRange('2026-11-05', '2026-11-03'), /on or after/);
    assert.throws(() => dateRange('2026-11-01', '2027-03-01'), /At most/);
  });
  test('toRows: back to usual hours is the weekday\'s hours, or a day off; split days are refused', () => {
    assert.deepEqual(toRows([{ date: '2026-11-03', usual: true }], weekly), [{ date: '2026-11-03', start_time: '08:00', end_time: '17:00' }]);
    assert.deepEqual(toRows([{ date: '2026-11-08', usual: true }], weekly), [{ date: '2026-11-08', dayoff: true }]); // a Sunday
    const split = [{ weekday: 2, dayoff: false, start_time: '08:00', end_time: '12:00' }, { weekday: 2, dayoff: false, start_time: '13:00', end_time: '17:00' }];
    assert.throws(() => toRows([{ date: '2026-11-03', usual: true }], split), (e) => e.status === 409 && /split/.test(e.message));
  });
  test('visitsAffected: every visit on a day off, visits outside new hours', () => {
    const days = [{ date: '2026-11-03', visits: [{ id: 7, start: 540, duration: 180, time: '9:00', end: '12:00', customer: 'Client 1' }] }];
    assert.equal(visitsAffected([{ date: '2026-11-03', dayoff: true }], days).length, 1);
    assert.equal(visitsAffected([{ date: '2026-11-03', start_time: '08:00', end_time: '12:00' }], days).length, 0);
    assert.deepEqual(visitsAffected([{ date: '2026-11-03', start_time: '10:00', end_time: '17:00' }], days), [{ date: '2026-11-03', time: '9:00', end: '12:00', customer: 'Client 1', booking_id: 7 }]);
  });
});

function world() {
  const teams = [{ id: 1, title: '(1)(F)Ann Usual', latitude: 45.4, longitude: -75.7, share: 22, tags_info: [] }];
  const dated = [];
  const posts = [];
  const bookings = [{ id: 2001, service_date: '2026-11-03T14:00:00Z', duration: 180, frequency: { name: 'One time' }, address: { latitude: 45.4, longitude: -75.7, city: 'Ottawa' }, user: { id: 1, name: 'Client 1', tags_info: [] }, services: [{ name: 'Standard clean' }], teams: [{ id: 1, hours: 3 }] }];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/latest/login') return json({ bearer: 'b' });
    if (u.pathname === '/v1/staff/teams') return json(Number(u.searchParams.get('offset')) ? [] : teams);
    if (u.pathname === '/v1/staff/teams/1/availability') {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push(body);
        for (const r of body) {
          const i = dated.findIndex((x) => x.date === r.date);
          if (i >= 0) dated.splice(i, 1);
          dated.push({ id: 9000 + posts.length, weekday: null, ...r, start_time: r.dayoff ? null : r.start_time, end_time: r.dayoff ? null : r.end_time });
        }
        return json(dated.filter((x) => body.some((r) => r.date === x.date)));
      }
      const from = u.searchParams.get('from');
      const to = u.searchParams.get('to');
      return json([...weekly.map((r) => ({ ...r, date: null })), ...(from && to ? dated.filter((r) => r.date >= from && r.date <= to) : [])]);
    }
    if (u.pathname === '/v1/staff/bookings') {
      const from = u.searchParams.get('from');
      const to = u.searchParams.get('to');
      return json(Number(u.searchParams.get('offset')) ? [] : bookings.filter((b) => b.service_date.slice(0, 10) >= from && b.service_date.slice(0, 10) <= to));
    }
    return json({ error: 'nf' }, 404);
  };
  return { dated, posts, fetchImpl };
}

describe('availability: read and save through the planner', () => {
  test('a day off is sent to Launch27, logged, and the planner sees it at once', async () => {
    const w = world();
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const writes = createWriteLog({ db });
    const s = createSchedule({ db, config, fetchImpl: w.fetchImpl, log: quiet, now: () => NOW, writes });
    await s.sync();

    const live = await s.readAvailability(1, '2026-11-03', '2026-11-03', 'b');
    assert.equal(live.weekly.length, 5);
    const before = await s.availabilityDays(1, '2026-11-03', '2026-11-03', live);
    assert.equal(before[0].kind, 'usual');
    assert.equal(before[0].visits.length, 1);
    assert.equal(before[0].visits[0].outside, false);

    await s.saveAvailability(1, [{ date: '2026-11-03', dayoff: true }], 'b', 'ops@example.com', 'mark a day off');
    assert.deepEqual(w.posts, [[{ date: '2026-11-03', dayoff: true }]]);
    const logged = (await writes.list()).rows.filter((r) => r.source === 'mark a day off');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].outcome, 'done');
    assert.equal(logged[0].user_email, 'ops@example.com');
    // The planner's copy has the day off now: her visit that day is flagged.
    assert.ok((await s.changes()).items.some((i) => i.title.includes('Ann Usual')));
    const after = await s.availabilityDays(1, '2026-11-03', '2026-11-03', await s.readAvailability(1, '2026-11-03', '2026-11-03', 'b'));
    assert.equal(after[0].kind, 'day_off');
    assert.equal(after[0].visits[0].outside, true);

    // Back to the usual hours: saved with the weekly hours, read as usual again.
    await s.saveAvailability(1, toRows([{ date: '2026-11-03', usual: true }], live.weekly), 'b');
    const back = await s.availabilityDays(1, '2026-11-03', '2026-11-03', await s.readAvailability(1, '2026-11-03', '2026-11-03', 'b'));
    assert.equal(back[0].kind, 'usual');

    const history = createAvailabilityHistory({ db });
    await history.record([{ cleaner_id: 1, cleaner_name: 'Ann Usual', date: '2026-11-03', before: { hours: '8:00–17:00', kind: 'usual' }, after: { date: '2026-11-03', dayoff: true }, outcome: 'saved', source: 'mark_off', by_name: 'Ops' }]);
    const rows = await history.list(1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, '2026-11-03');
    assert.equal(rows[0].source, 'mark_off');
  });

  test('with Launch27 writes off nothing is sent, and the attempt is logged as blocked', async () => {
    const w = world();
    const db = await openDb();
    const config = { ...loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' }), allowWrites: false };
    const writes = createWriteLog({ db });
    const s = createSchedule({ db, config, fetchImpl: w.fetchImpl, log: quiet, now: () => NOW, writes });
    await s.sync();
    await assert.rejects(() => s.saveAvailability(1, [{ date: '2026-11-03', dayoff: true }], 'b'), (e) => e.status === 403);
    assert.equal(w.posts.length, 0);
    assert.equal((await writes.list()).rows[0].outcome, 'blocked');
  });
});

describe('availability: test Launch27', () => {
  test('saves dated rows as Launch27 does and returns them on a range read', async () => {
    const f = createMockLaunch27({ now: () => NOW });
    const init = (method, body) => ({ method, headers: { authorization: 'Bearer mock-bearer', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const bad = await f('https://mock.test/v1/staff/teams/1/availability', init('POST', { date: '2026-11-03' }));
    assert.equal(bad.status, 400);
    const ok = await f('https://mock.test/v1/staff/teams/1/availability', init('POST', [{ date: '2026-11-03', dayoff: true }]));
    assert.equal(ok.status, 200);
    const rows = await (await f('https://mock.test/v1/staff/teams/1/availability?from=2026-11-03&to=2026-11-03', init('GET'))).json();
    assert.ok(rows.some((r) => r.date === '2026-11-03' && r.dayoff));
  });
});
