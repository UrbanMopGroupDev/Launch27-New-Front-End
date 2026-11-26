import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { utilizationFacts, utilizationReport, clampRange, dataCheck, withRecordedDays } from '../src/reports/utilization.js';
import { createReports } from '../src/reports/service.js';
import { createSchedule } from '../src/schedule/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig, canSeeUtilization } from '../src/config.js';
import { createApp } from '../src/app.js';

const quiet = { info() {}, warn() {}, error() {} };
const HOME = { lat: 45.4215, lng: -75.6972 }; // downtown: Central
const week = (start = '09:00', end = '17:00') => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ id: d, date: null, weekday: d, dayoff: false, start_time: start, end_time: end }));
const visit = (key, date, start, end, team, over = {}) => ({ key, date, start, end, duration: end - start, team_ids: team, team_hours: {}, location_id: 1, customer_id: 100, kind: 'weekly', ...HOME, ...over });

// Monday Nov 9 to Sunday Nov 15, 2026; cleaners work 9 to 5 every day, Sunday included.
const TODAY = '2026-11-09';
const A = { id: 1, name: 'A', area: 'Central', assignable: true, location_ids: [1], ...HOME, rules: {}, availability: [...week(), { id: 99, date: '2026-11-12', weekday: null, dayoff: false, start_time: '09:00', end_time: '13:00' }] };
const B = { id: 2, name: 'B', area: 'Central', assignable: true, location_ids: [1, 2], ...HOME, rules: {}, availability: week() };
const OFF = { id: 3, name: 'On hold', area: 'Central', assignable: false, location_ids: [1], ...HOME, rules: {}, availability: week() };
const VISITS = [
  visit('v1', '2026-11-09', 540, 720, [1, 2], { team_hours: { 1: 3, 2: 3 } }), // two cleaners, Monday 9–12
  visit('v2', '2026-11-15', 600, 720, [1]), // Sunday: left out
  visit('v3', '2026-11-10', 600, 720, [], { customer_id: 101, kind: 'one' }), // unassigned, Tuesday
  visit('v4', '2026-11-15', 600, 720, []), // unassigned Sunday: left out
  visit('v5', '2026-11-11', 540, 720, [2], { location_id: 2, customer_id: 102 }), // B, the other brand
  visit('v6', '2026-11-13', 780, 960, [1]), // A, Friday 1–4pm
  visit('v7', '2026-11-14', 600, 660, [3]), // on a cleaner not taking bookings
];
const HOLIDAYS = [{ date: '2026-11-12', start_time: '00:00', end_time: '23:59', location_id: 1 }];
const facts = (locations = null, mode = 'all') => utilizationFacts({ today: TODAY, cleaners: [A, B, OFF], visits: VISITS, holidays: HOLIDAYS, locations, mode, until: '2026-11-15' });

const report = (locations = null, mode = 'all') => utilizationReport({ facts: facts(locations, mode), from: TODAY, to: '2026-11-15', maxTo: '2026-11-15' });

describe('utilization: the arithmetic, by hand', () => {
  test('available − assigned − unassigned − not taking − travel = left; Sundays out', () => {
    const t = report().totals;
    // A: 5 days × 8h + Thursday's own 4h (closed date, but A set hours that day) = 44. B: 5 × 8, Thursday closed = 40.
    assert.equal(t.available_h, 84);
    assert.equal(t.closed_h, 8);
    // v1 counts against both cleaners (3 + 3), v5 3h, v6 3h. Sunday v2 is left out.
    assert.equal(t.assigned_h, 12);
    assert.equal(t.unassigned_h, 2);
    assert.equal(t.unassigned_visits, 1);
    assert.equal(t.not_taking_h, 1);
    // Every stop is at home, so each leg is the 6-minute minimum: 4 cleaner-days × (out + home) = 48 min,
    // plus one average leg (6) each for the unassigned visit and the one on the on-hold cleaner.
    assert.equal(t.travel_h, 1);
    assert.equal(t.spoken_h, 16);
    assert.equal(t.left_h, 68);
    assert.equal(t.utilization, 16 / 84);
    // Room for: 3.1 h slots (a typical 3 h booking + a 6-min drive) that fit into each cleaner's open
    // stretches. A: Mon 1 (after v1), Tue 2, Wed 2, Thu 1 (own 4 h), Fri 1 (before v6; 54 min after
    // is too short), Sat 2 = 9. B: Mon 1, Tue 2, Wed 1 (after v5), Thu 0 (closed), Fri 2, Sat 2 = 8.
    // 17 slots − the unassigned visit − the visit to move = 15.
    assert.equal(t.typical_booking_h, 3);
    assert.equal(t.room_bookings, 15);
  });

  test('all work (default): a shared cleaner keeps their full hours; commercial is committed, shown on its own', () => {
    const t = report([1]).totals;
    assert.equal(t.available_h, 84); // B's Wednesday 9–12 for commercial is not taken off
    assert.equal(t.assigned_h, 9);
    assert.equal(t.commercial_h, 3);
    assert.equal(t.commercial_visits, 1);
    assert.equal(t.travel_h, 1); // the drives to and from the commercial visit count too
    assert.equal(t.spoken_h, 9 + 3 + 2 + 1 + 1);
    assert.equal(t.left_h, 84 - 16);
    assert.equal(t.customers, 2);
  });

  test('residential only: the shared cleaner loses the hours booked for commercial', () => {
    const t = report([1], 'residential').totals;
    assert.equal(t.available_h, 81); // B's Wednesday 9–12 went to commercial
    assert.equal(t.assigned_h, 9);
    assert.equal(t.commercial_h, 0);
    assert.equal(t.travel_h, 0.8); // B's Wednesday route is commercial's
    assert.equal(t.customers, 2);
  });

  test('by cleaner, by area, by day', () => {
    const r = report();
    const a = r.cleaners.find((c) => c.cleaner_id === 1);
    assert.deepEqual([a.available_h, a.assigned_h, a.travel_h, a.left_h, a.visits], [44, 6, 0.4, 37.6, 2]);
    assert.ok(Math.abs(a.if_left - 6.4 / 68) < 1e-9);
    assert.equal(r.areas.find((x) => x.area === 'Central').left_h, 68);
    assert.deepEqual(r.by_day.map((d) => d.date), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    const mon = r.by_day[0];
    assert.deepEqual([mon.available_h, mon.spoken_h, mon.left_h], [16, 6.4, 9.6]);
    assert.equal(mon.areas.Central.left_h, 9.6);
  });

  test('any date range, kept within today … the end of the planner copy', () => {
    assert.deepEqual(clampRange('2026-11-09', '2026-11-12', '2026-11-12', '2027-01-03'), { from: '2026-11-12', to: '2026-11-12' });
    assert.deepEqual(clampRange('2026-11-09', '2026-11-01', '2027-02-01', '2027-01-03'), { from: '2026-11-09', to: '2027-01-03' });
    assert.deepEqual(clampRange('2026-11-09', 'junk', null, '2027-01-03'), { from: '2026-11-09', to: '2026-11-15' });
    assert.deepEqual(clampRange('2026-11-09', '2026-11-20', '2026-11-10', '2027-01-03'), { from: '2026-11-20', to: '2026-11-20' });
    const one = utilizationReport({ facts: facts(), from: '2026-11-13', to: '2026-11-13', maxTo: '2026-11-15' }).totals;
    assert.deepEqual([one.available_h, one.assigned_h], [16, 3]);
  });
});

describe('utilization: on the sample Launch27', () => {
  test('ties to Scheduling insights for any dates and brand; nothing on a Sunday', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    const src = await schedule.utilizationSource();
    const t0 = src.today;
    const add = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    for (const [locations, mode] of [[null, 'all'], [[1], 'all'], [[1], 'residential'], [[167, 168], 'all'], [[167, 168], 'residential']]) {
      for (const [from, to] of [[t0, add(t0, 6)], [add(t0, 3), add(t0, 3)], [t0, add(t0, 55)], [add(t0, 10), add(t0, 24)]]) {
        const r = await reports.utilization({ from, to, locations, mode });
        const label = `${from}..${to} ${locations || 'both'} ${mode}`;
        assert.equal(r.mode, mode);
        assert.ok(r.reconcile.capacity.ties, `capacity ${label}`);
        assert.ok(r.reconcile.booked.ties, `booked ${label}`);
        assert.ok(r.reconcile.unassigned.ties, `unassigned ${label}`);
        const t = r.totals;
        assert.ok(Math.abs(t.left_h - (t.available_h - t.assigned_h - t.commercial_h - t.unassigned_h - t.not_taking_h - t.travel_h)) < 0.3, label);
        assert.ok(r.by_day.every((d) => new Date(`${d.date}T12:00:00Z`).getUTCDay() !== 0), `no Sundays ${label}`);
      }
    }
    assert.ok(src.holidays.some((h) => h.date.endsWith('-12-25')), 'closed dates are read');
    await db.close();
  });

  test('everyone sees it, production included; UTILIZATION_EMAILS can narrow it', async () => {
    assert.equal(canSeeUtilization(loadConfig({ APP_ENV: 'production', DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(40) }), 'boss@example.com'), true);
    assert.equal(canSeeUtilization(loadConfig({ APP_ENV: 'production', UTILIZATION_EMAILS: 'boss@example.com', DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(40) }), 'someone@example.com'), false);
    assert.equal(canSeeUtilization(loadConfig({ APP_ENV: 'development', UTILIZATION_EMAILS: 'Boss@Example.com' }), 'someone@example.com'), false);
    assert.equal(canSeeUtilization(loadConfig({ APP_ENV: 'development', UTILIZATION_EMAILS: 'Boss@Example.com' }), 'boss@example.com'), true);
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    const server = createApp(config, { fetchImpl, db, schedule, reports }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const email of ['boss@example.com', 'someone@example.com']) {
        const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo' }) });
        const cookie = res.headers.get('set-cookie').split(';')[0];
        const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
        assert.equal(me.features.utilization, true, email);
        const ut = await fetch(`${base}/api/reports/utilization`, { headers: { cookie } });
        assert.equal(ut.status, 200, email);
        const body = await ut.json();
        assert.equal(body.from, body.today); // default: the next 7 days
      }
    } finally {
      server.close();
      await db.close();
    }
  });
});

describe('utilization: data check', () => {
  test('flags refused hours, booked with no hours, booked while not taking, no hours set, no home location', () => {
    const NOHOURS = { id: 4, name: 'No hours', area: 'Unknown', assignable: true, location_ids: [1], lat: null, lng: null, rules: {}, availability: [] };
    const REFUSED = { ...NOHOURS, id: 5, name: 'Refused', ...HOME, area: 'Central', availability_error: 'Launch27 refused: not allowed for this login (403)' };
    const visits = [...VISITS, visit('v8', '2026-11-10', 600, 720, [4]), visit('v9', '2026-11-11', 600, 720, [5])];
    const all = [A, B, OFF, NOHOURS, REFUSED].map((c) => ({ ...c, weekly_hours: c.availability.length ? 8 * 7 : 0, status_label: c.assignable ? 'Active' : 'On hold' }));
    const f = utilizationFacts({ today: TODAY, cleaners: all, visits, holidays: HOLIDAYS, until: '2026-11-15' });
    const dc = dataCheck({ facts: f, inWin: (d) => d >= TODAY && d <= '2026-11-15', cleaners: all, source: { full_at: '2026-11-09T10:00:00Z', cleaners_by: 'person' } });
    const kinds = (id) => dc.cleaners.find((c) => c.cleaner_id === id).flags.map((x) => x.kind);
    assert.deepEqual(kinds(5), ['refused', 'booked_no_hours', 'over_availability']);
    assert.deepEqual(kinds(4), ['booked_no_hours', 'over_availability', 'no_hours', 'no_home']);
    assert.deepEqual(kinds(3), ['booked_not_taking']);
    assert.deepEqual(kinds(1), []);
    assert.equal(dc.cleaners[0].cleaner_id, 5); // problems first, refused at the top
    assert.equal(dc.counts.booked_no_hours, 2);
    assert.equal(dc.read_by, 'person');
  });

  test('the planner records a refusal instead of hiding it, and retries a temporary one', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const mock = createMockLaunch27({ password: 'demo' });
    let tries429 = 0;
    const fetchImpl = async (url, init) => {
      if (url.includes('/v1/staff/teams/9000/availability')) return new Response('{}', { status: 403 });
      if (url.includes('/v1/staff/teams/9001/availability') && tries429++ === 0) return new Response('{}', { status: 429 });
      return mock(url, init);
    };
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet, retryDelayMs: 0 });
    await schedule.sync();
    const src = await schedule.utilizationSource();
    const c0 = src.cleaners.find((c) => c.id === 9000);
    const c1 = src.cleaners.find((c) => c.id === 9001);
    assert.equal(c0.availability_error, 'Launch27 refused: not allowed for this login (403)');
    assert.deepEqual(c0.availability, []);
    assert.equal(c1.availability_error, null); // 429 once, then fine on the retry
    assert.ok(c1.availability.length > 0);
    assert.equal(src.cleaners_by, 'sync');
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    const r = await reports.utilization({});
    assert.ok(r.data_check.cleaners.find((c) => c.cleaner_id === 9000).flags.some((f) => f.kind === 'refused'));
    await db.close();
  });
});

describe('reading Launch27 hours', () => {
  test('times in any common format', async () => {
    const { toMinutes } = await import('../src/schedule/rules.js');
    assert.deepEqual(['09:00', '9:00:00', '9:00 AM', '9am', '5:00 PM', '5pm', '17:30', '12:00 PM', '12:30 AM'].map(toMinutes), [540, 540, 540, 540, 1020, 1020, 1050, 720, 30]);
  });
  test('a date row with no times does not wipe out the weekly hours; split days count; AM/PM read right', async () => {
    const { workingWindow, weeklyHours } = await import('../src/schedule/rules.js');
    const rows = [
      { date: null, weekday: 1, dayoff: false, start_time: '9:00 AM', end_time: '5:00 PM' },
      { date: null, weekday: 2, dayoff: false, start_time: '08:00', end_time: '12:00' },
      { date: null, weekday: 2, dayoff: false, start_time: '13:00', end_time: '17:00' },
      { date: '2026-11-16', weekday: null, dayoff: false, start_time: null, end_time: null }, // Monday, says nothing
      { date: '2026-11-23', weekday: null, dayoff: true, start_time: null, end_time: null }, // Monday off
      { date: '2026-11-30', weekday: null, dayoff: false, start_time: '10:00', end_time: '14:00' }, // short Monday
    ];
    assert.deepEqual(workingWindow(rows, '2026-11-16'), [540, 1020]);
    assert.equal(workingWindow(rows, '2026-11-23'), null);
    assert.deepEqual(workingWindow(rows, '2026-11-30'), [600, 840]);
    assert.deepEqual(workingWindow(rows, '2026-11-17'), [480, 1020]);
    assert.equal(weeklyHours(rows), 8 + 8);
  });
});
test('a split day counts its blocks, not the gap', async () => {
  const { workingMinutes } = await import('../src/schedule/rules.js');
  const rows = [{ date: null, weekday: 2, dayoff: false, start_time: '08:00', end_time: '12:00' }, { date: null, weekday: 2, dayoff: false, start_time: '13:00', end_time: '17:00' }];
  assert.equal(workingMinutes(rows, '2026-11-17'), 480);
});

describe('utilization: past weeks and shared cleaners', () => {
  test('past dates can be chosen back to the earliest kept date', () => {
    assert.deepEqual(clampRange('2026-11-17', '2026-11-08', '2026-11-14', '2027-01-11', '2026-09-22'), { from: '2026-11-08', to: '2026-11-14' });
    assert.deepEqual(clampRange('2026-11-17', '2026-08-01', '2026-08-10', '2027-01-11', '2026-09-22'), { from: '2026-09-22', to: '2026-09-22' });
  });

  test('a past week is counted like any other, and marked past', () => {
    // "Today" is the Sunday after the test week, so the whole week Nov 9–14 is in the past.
    const f = utilizationFacts({ today: '2026-11-15', start: TODAY, cleaners: [A, B, OFF], visits: VISITS, holidays: HOLIDAYS, until: '2026-11-15' });
    const r = utilizationReport({ facts: f, from: TODAY, to: '2026-11-14', maxTo: '2027-01-10', minFrom: '2026-09-20' });
    assert.equal(r.past, true);
    assert.equal(r.min_from, '2026-09-20');
    assert.equal(r.totals.available_h, 84);
    assert.equal(r.totals.assigned_h, 12);
    assert.equal(r.totals.unassigned_h, 2);
  });

  test('a shared cleaner shows open hours and the commercial share', () => {
    const all = report([1]).cleaners.find((c) => c.cleaner_id === 2);
    assert.deepEqual([all.open_h, all.available_h, all.commercial_h, all.commercial_visits], [40, 40, 3, 1]);
    const r = report([1], 'residential');
    const b = r.cleaners.find((c) => c.cleaner_id === 2);
    assert.deepEqual([b.open_h, b.other_brand_h, b.available_h], [40, 3, 37]); // Wednesday 9–12 went to commercial
    const a = r.cleaners.find((c) => c.cleaner_id === 1);
    assert.deepEqual([a.open_h, a.other_brand_h, a.available_h], [44, 0, 44]);
  });

  test('the planner keeps visits and one-day changes from past weeks for the report', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet, retryDelayMs: 0 });
    await schedule.sync();
    const src = await schedule.utilizationSource();
    assert.ok(src.history_from < src.today);
    assert.ok(src.visits.some((v) => v.date < src.today), 'past visits are included');
    assert.ok(src.cleaners.some((c) => c.availability.some((row) => row.date && String(row.date).slice(0, 10) < addDaysT(src.today, -7))), 'one-day changes older than a week are kept');
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    const r = await reports.utilization({ from: addDaysT(src.today, -14), to: addDaysT(src.today, -8) });
    assert.equal(r.past, true);
    assert.equal(r.from, addDaysT(src.today, -14));
    assert.ok(r.totals.available_h > 0 && r.totals.assigned_h > 0);
    await db.close();
  });
});
const addDaysT = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('utilization: bookings that need a cleaner', () => {
  test('lists unassigned and to-move bookings in the dates, Monday to Saturday, once each', () => {
    const r = report();
    const list = r.needs_cleaner;
    // v3 (Tuesday, unassigned) and v7 (Saturday, on the on-hold cleaner); Sunday v4 is left out.
    assert.deepEqual(list.map((x) => [x.kind, x.key]), [['unassigned', 'v3'], ['not_taking', 'v7']]);
    assert.equal(list[0].hours, 2);
    assert.equal(list[1].cleaner, 'On hold');
    assert.equal(list.filter((x) => x.kind === 'unassigned').length, r.totals.unassigned_visits);
  });
});

test('room for counts bookings that fit into real gaps, not hours ÷ length', () => {
  // One cleaner, Monday 9–5 (8 h), with a 2 h visit at 12–2 in the middle: 3 h before, 3 h after.
  const C = { id: 7, name: 'C', area: 'Central', assignable: true, location_ids: [1], ...HOME, rules: {}, availability: week() };
  const f = utilizationFacts({ today: TODAY, cleaners: [C], visits: [visit('m', '2026-11-09', 720, 840, [7], { duration: 120 })], until: '2026-11-09' });
  const t = utilizationReport({ facts: f, from: TODAY, to: TODAY, maxTo: '2026-11-15' }).totals;
  // A typical booking here is 2 h + a 6-min drive = 126 min. Before: 9:00–11:54 (174 min) fits 1;
  // after: 2:06–5:00 (174 min) fits 1.
  // Four 1 h visits at 10, 12, 2 and 4: about 3.5 open hours remain, but every gap is under an hour
  // (9:00–9:54, 11:06–11:54, …), too short for a 1 h visit plus its 6-min drive: room for none.
  assert.equal(t.room_bookings, 2);
  const g = utilizationFacts({ today: TODAY, cleaners: [C], visits: [visit('a', '2026-11-09', 600, 660, [7], { duration: 60 }), visit('b', '2026-11-09', 720, 780, [7], { duration: 60 }), visit('c', '2026-11-09', 840, 900, [7], { duration: 60 }), visit('d', '2026-11-09', 960, 1020, [7], { duration: 60 })], until: '2026-11-09' });
  const u = utilizationReport({ facts: g, from: TODAY, to: TODAY, maxTo: '2026-11-15' }).totals;
  assert.ok(u.left_h > 3, 'several open hours remain');
  assert.equal(u.room_bookings, 0, 'no gap fits a 1 h visit plus its drive');
});

describe('utilization: daily history record', () => {
  test('a saved day replaces the same day rebuilt from current hours', () => {
    // Live: A works 9–5 every day now. The record for Tue Nov 10 says A only had 9–1 that day.
    const live = utilizationFacts({ today: '2026-11-16', start: TODAY, cleaners: [A], visits: [], until: '2026-11-15' });
    const A_then = { ...A, availability: [{ id: 1, date: null, weekday: 2, dayoff: false, start_time: '09:00', end_time: '13:00' }] };
    const rec = { ...utilizationFacts({ today: '2026-11-16', start: '2026-11-10', until: '2026-11-10', cleaners: [A_then], visits: [] }), recorded_days: ['2026-11-10'] };
    const merged = withRecordedDays(live, [rec]);
    const t = utilizationReport({ facts: merged, from: '2026-11-10', to: '2026-11-10', maxTo: '2027-01-10' }).totals;
    assert.equal(t.available_h, 4);
    const wk = utilizationReport({ facts: merged, from: TODAY, to: '2026-11-14', maxTo: '2027-01-10' }).totals;
    // Mon 8 + Tue 4 (recorded) + Wed 8 + Thu 4 (A's own Thursday hours) + Fri 8 + Sat 8 = 40.
    assert.equal(wk.available_h, 40);
    assert.deepEqual(merged.recorded_days, ['2026-11-10']);
  });

  test('the planner saves today and yesterday on each refresh; the report uses saved past days', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet, retryDelayMs: 0 });
    await schedule.sync();
    const src = await schedule.utilizationSource();
    const y = addDaysT(src.today, -1);
    const rows = (await db.query('SELECT day FROM utilization_days ORDER BY day')).rows;
    assert.equal(rows.length, 2);
    const saved = await schedule.recordedDays(y, src.today);
    assert.deepEqual(saved.map((r) => r.day), [y, src.today]);
    assert.ok(saved[0].cleaners.length > 0 && Array.isArray(saved[0].visits));
    assert.ok(saved[0].cleaners.every((c) => c.availability.every((row) => !row.date || String(row.date).slice(0, 10) === y)), 'only that day\'s one-day changes are kept');
    // Pretend yesterday everyone had the day off: the report must follow the record, not today's hours.
    const off = { ...saved[0], cleaners: saved[0].cleaners.map((c) => ({ ...c, availability: [] })) };
    delete off.day;
    await db.query('UPDATE utilization_days SET data = $2::jsonb WHERE day = $1', [y, JSON.stringify(off)]);
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    const r = await reports.utilization({ from: y, to: y });
    if (new Date(`${y}T12:00:00Z`).getUTCDay() !== 0) {
      assert.equal(r.totals.available_h, 0);
      assert.deepEqual([r.history.recorded_days, r.history.past_days], [1, 1]);
    }
    assert.equal(r.history.first_recorded, y);
    await db.close();
  });
});

describe('utilization: residential/commercial transition', () => {
  const F = { id: 11, name: 'Floyd', area: 'Central', assignable: true, location_ids: [1], ...HOME, rules: {}, availability: week('08:00', '18:00') };
  const J = { id: 12, name: 'Joel', area: 'Central', assignable: true, location_ids: [1], ...HOME, rules: {}, availability: week('08:00', '20:30') };
  const T = { id: 13, name: 'Tara', area: 'Central', assignable: true, location_ids: [1], ...HOME, rules: {}, availability: week('08:00', '20:30') };
  const one = (cleaners, visits, extra = {}) => {
    const f = utilizationFacts({ today: '2026-11-23', cleaners, visits, until: '2026-12-05', ...extra });
    return utilizationReport({ facts: f, from: '2026-11-23', to: '2026-12-05', maxTo: '2027-01-10', cleaners });
  };

  test('each booking counts its full scheduled Duration, not the time on site (Floyd: 2 h, not 1.5 h)', () => {
    // Nov 27 11:30, scheduled 2 h; Launch27 says Floyd's own hours on it were 1.5.
    const r = one([F], [visit('bruyere', '2026-11-27', 690, 810, [11], { team_hours: { 11: 1.5 } })]);
    assert.equal(r.cleaners[0].assigned_h, 2);
    assert.equal(r.totals.assigned_h, 2);
  });

  test('every cleaner on a booking counts its full Duration (Joel and Tara: 3 h each, twice = 6 h each)', () => {
    const v = (key, date) => visit(key, date, 1050, 1230, [12, 13], { team_hours: { 12: 2.5, 13: 2.5 } }); // 5:30 PM, 3 h
    const r = one([J, T], [v('t1', '2026-11-27'), v('t2', '2026-12-01')]);
    assert.deepEqual(r.cleaners.map((c) => c.assigned_h), [6, 6]);
    assert.equal(r.totals.assigned_h, 12);
  });

  test('a booking past the cleaner\'s hours counts in full and shows as over availability', () => {
    // Floyd works 8–6; a 3 h booking at 4:30 PM runs 1.5 h past.
    const r = one([F], [visit('late', '2026-11-24', 990, 1170, [11])]);
    assert.equal(r.cleaners[0].assigned_h, 3);
    const row = r.data_check.cleaners.find((c) => c.cleaner_id === 11);
    assert.equal(row.over_h, 1.5);
    assert.ok(row.flags.some((f) => f.kind === 'over_availability'));
  });

  test('every block of a split day counts, and gaps come from each block (Friday 8–1 and 2:15–6)', () => {
    const S = { id: 14, name: 'Split', area: 'Central', assignable: true, location_ids: [1], ...HOME, rules: {}, availability: [
      { date: null, weekday: 5, dayoff: false, start_time: '8:00 AM', end_time: '1:00 PM' },
      { date: null, weekday: 5, dayoff: false, start_time: '2:15 PM', end_time: '6:00 PM' },
    ] };
    const f = utilizationFacts({ today: '2026-11-23', cleaners: [S], visits: [], until: '2026-11-27' });
    const fri = f.days.find((x) => x.d === '2026-11-27');
    assert.equal(fri.avail, 5 * 60 + 225);
    assert.deepEqual(fri.gaps, [300, 225]); // the 1:00–2:15 break is not open time
  });

  test('a day excluded from booking in Launch27 is not open time', () => {
    const r = one([F], [], { excluded: new Map([[11, new Set(['2026-11-28'])]]) });
    // Two weeks, Mon–Sat, 10 h a day = 120 h, less Saturday Nov 28.
    assert.equal(r.totals.available_h, 110);
    assert.equal(r.totals.excluded_h, 10);
    assert.equal(r.data_check.cleaners[0].excluded_days, 1);
  });

  test('a commercial cleaner who takes residential bookings is counted once, not dropped', () => {
    const M = { id: 15, name: 'Commercial', area: 'Central', assignable: true, location_ids: [167], ...HOME, rules: {}, availability: week('08:00', '16:00') };
    const visits = [visit('res', '2026-11-24', 540, 720, [15]), visit('com', '2026-11-25', 540, 720, [15], { location_id: 167 })];
    const f = utilizationFacts({ today: '2026-11-23', cleaners: [F, M], visits, locations: [1], until: '2026-12-05' });
    const r = utilizationReport({ facts: f, from: '2026-11-23', to: '2026-12-05', maxTo: '2027-01-10' });
    const m = r.cleaners.find((c) => c.cleaner_id === 15);
    assert.deepEqual([m.assigned_h, m.commercial_h, m.other_locations], [3, 3, true]);
    assert.equal(r.totals.not_taking_h, 0);
    assert.equal(r.totals.assigned_h, 3);
    assert.equal(r.totals.commercial_h, 3);
    // A commercial cleaner with no residential work is not part of the residential report.
    const g = utilizationFacts({ today: '2026-11-23', cleaners: [F, M], visits: [visits[1]], locations: [1], until: '2026-12-05' });
    assert.ok(!g.taking.some((c) => c.id === 15));
  });

  test('data check: partner bookings filed under a residential location; hours under 60% of Launch27 weekly', () => {
    const visits = [
      visit('owcs', '2026-11-24', 540, 660, [11], { partner_kind: 'homemaking', partner_name: 'OWCS Homemaking' }),
      visit('ok', '2026-11-24', 720, 840, [11]),
      visit('owcs-com', '2026-11-25', 540, 660, [11], { location_id: 167, partner_kind: 'homemaking', partner_name: 'OWCS Homemaking' }),
    ];
    const away = new Map([[11, new Set(['2026-11-23', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'])]]);
    const f = utilizationFacts({ today: '2026-11-23', cleaners: [F], visits, locations: [1], unavailable: away, until: '2026-11-28' });
    const dc = utilizationReport({ facts: f, from: '2026-11-23', to: '2026-11-28', maxTo: '2027-01-10', cleaners: [F] }).data_check;
    assert.deepEqual(dc.partner_bookings.map((b) => b.key), ['owcs']);
    const row = dc.cleaners.find((c) => c.cleaner_id === 11);
    assert.deepEqual([row.report_h, row.weekly_window_h], [10, 60]);
    assert.ok(row.flags.some((x) => x.kind === 'low_hours'));
  });

  test('the planner reads days excluded from booking (Launch27 Daily spots)', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const mock = createMockLaunch27({ password: 'demo' });
    let someone = null;
    let day = null;
    const fetchImpl = async (url, init) => {
      const m = String(url).match(/\/v1\/staff\/locations\/(\d+)\/spots\?(.*)$/);
      if (m && someone && day) {
        const q = new URLSearchParams(m[2]);
        const days = q.get('from') <= day && q.get('to') >= day
          ? [{ date: day, spots: [{ teams: { available_ids: [], excluded_ids: [someone] } }, { teams: { available_ids: [], excluded_ids: [someone] } }] }]
          : [];
        return new Response(JSON.stringify({ grid: [], days }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return mock(url, init);
    };
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet, retryDelayMs: 0 });
    await schedule.sync();
    const first = await schedule.utilizationSource();
    someone = first.cleaners.find((c) => c.assignable && c.weekly_hours > 0).id;
    day = addDaysT(first.today, 3);
    await schedule.sync();
    const src = await schedule.utilizationSource();
    assert.ok(src.excluded.get(someone)?.has(day));
    await db.close();
  });
});
