import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { classify, commercialTest, computeSlots, DEFAULT_SETTINGS, genderRank, genderWanted, partnerSnapshot, planWeek, suggestSlots, teamStats, withDetails } from '../src/commercial/workforce-core.js';
import { noteHints } from '../src/commercial/partners.js';
import { customerPrefs } from '../src/schedule/rules.js';
import { createWorkforce, fsaOfPostal, nearestFsa, tidyPostal } from '../src/commercial/workforce.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { createSchedule } from '../src/schedule/service.js';
import { seed } from '../src/inbox/seed.js';

// ---------- made-up data: a week of Commercial visits around Ottawa ----------
const WEEK = '2026-11-16'; // a Monday
const TODAY = '2026-11-12';
const P = { a: { lat: 45.42, lng: -75.69 }, b: { lat: 45.43, lng: -75.68 }, far: { lat: 45.3, lng: -75.9 } };
const hours = (from = '08:00', to = '17:00', days = [1, 2, 3, 4, 5]) => days.map((weekday) => ({ weekday, start_time: from, end_time: to }));
const cleaner = (id, name, extra = {}) => ({ id, name, status: 'active', assignable: true, gender: 'F', rules: {}, availability: hours(), location_ids: [167], ...extra });
let n = 0;
const visit = (date, start, mins, team, extra = {}) => ({
  key: `v${++n}`, id: n, date, start, duration: mins, end: start + mins, team_ids: team, location_id: 167, kind: 'weekly', freq: 'Weekly',
  customer_id: extra.customer_id ?? -n, customer: extra.customer || `Client ${n}`, services: ['Carefor Homemaking (1 Cleaner x 2.00 Hours)'], partner_kind: 'homemaking', partner_name: 'Carefor Homemaking',
  addr: `${n} Main St`, area: 'Ottawa', ...P.a, ...extra,
});
const res = (date, start, mins, team) => visit(date, start, mins, team, { location_id: 1, partner_kind: null, partner_name: null, services: ['Two Bedroom Home'] });
const windowFor = (c, d) => {
  const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
  const row = (c.availability || []).find((r) => r.weekday === wd);
  return row ? [Number(row.start_time.slice(0, 2)) * 60, Number(row.end_time.slice(0, 2)) * 60] : null;
};
const isCom = commercialTest([167, 168]);
function ctxOf(visits, cleaners, { ticks = new Map(), lastDay = new Map(), state = new Map(), settings = DEFAULT_SETTINGS } = {}) {
  const team = teamStats({ visits, cleaners, today: TODAY, isCom, ticks, lastDay });
  return { today: TODAY, visits, cleaners, windowFor, isCom, team, state, settings };
}

describe('commercial workforce: rules', () => {
  test('accounts and categories', () => {
    const c = (v) => { const r = classify(v); return [r.category, r.account]; };
    assert.deepEqual(c({ partner_kind: 'homemaking', partner_name: 'Carefor Homemaking', services: [] }), ['Homemaking', 'Carefor']);
    assert.deepEqual(c({ partner_kind: 'program', partner_name: 'Montfort at Home', services: [] }), ['Transition programs', 'Montfort at Home']);
    assert.deepEqual(c({ partner_kind: 'homemaking', partner_name: 'OWCS Homemaking', account_name: 'OWCS Going Home Program', services: [] }), ['Transition programs', 'OWCS GHP']);
    assert.deepEqual(c({ partner_kind: 'after', customer: 'Jane Doe', services: ['Past Temporary Homemaking'] }), ['Past temporary homemaking', 'Jane Doe']);
    assert.deepEqual(c({ partner_kind: 'company', partner_name: 'EOPMG Poulin', services: ['Commercial'] }), ['EOPMG', 'EOPMG']);
    assert.deepEqual(c({ partner_kind: 'company', partner_name: 'Acme Dental', services: ['Commercial'] }), ['Commercial accounts', 'Acme Dental']);
    assert.deepEqual(c({ customer: 'Sam Lee', services: ['Two Bedroom Home'] }), ['Residential under Commercial', 'Sam Lee']);
    // Commercial = booked at a Commercial location, or a partner's visit wherever it was booked.
    assert.ok(isCom({ location_id: 168 }) && isCom({ location_id: 1, partner_kind: 'program' }) && !isCom({ location_id: 1 }));
  });

  test('the Commercial team is suggested from the share of hours; a tick overrides it', () => {
    const cleaners = [cleaner(1, 'Mostly Com'), cleaner(2, 'Mostly Res'), cleaner(3, 'Never Com')];
    const visits = [visit('2026-11-10', 540, 180, [1]), res('2026-11-10', 780, 60, [1]), visit('2026-11-10', 540, 60, [2]), res('2026-11-11', 540, 240, [2]), res('2026-11-11', 540, 240, [3])];
    const rows = teamStats({ visits, cleaners, today: TODAY, isCom });
    assert.deepEqual(rows.map((r) => [r.name, r.suggested, r.commercial]), [['Mostly Com', true, true], ['Mostly Res', false, false]]);
    const ticked = teamStats({ visits, cleaners, today: TODAY, isCom, ticks: new Map([[2, true], [1, false], [3, true]]) });
    assert.deepEqual(ticked.map((r) => [r.name, r.commercial]).sort(), [['Mostly Com', false], ['Mostly Res', true], ['Never Com', true]]);
  });

  test('a visit held outside the team moves to the Commercial cleaner who knows the account', () => {
    const cleaners = [cleaner(1, 'Com Knows'), cleaner(2, 'Com New'), cleaner(3, 'Res Holder')];
    const visits = [
      visit('2026-11-03', 540, 120, [1]), // history: 1 has served Carefor
      visit('2026-11-04', 540, 120, [2], { partner_name: 'OWCS Homemaking', services: ['OWCS Homemaking'] }),
      res('2026-11-05', 540, 480, [3]), res('2026-11-06', 540, 480, [3]),
      visit('2026-11-17', 600, 120, [3], { customer_id: -500, customer: 'Jane Doe' }),
    ];
    const plan = planWeek(ctxOf(visits, cleaners), WEEK);
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.deepEqual([a.kind, a.state, a.holders[0].name, a.pick.name, a.pick.served], ['move', 'proposed', 'Res Holder', 'Com Knows', true]);
    assert.deepEqual(a.candidates.map((c) => c.name), ['Com Knows', 'Com New']);
    assert.equal(plan.totals.move, 1);
    // The move shows on the board: out of the holder's day, into the pick's.
    const day = (id) => plan.board.find((r) => r.id === id).days.find((d) => d.date === '2026-11-17').blocks.map((b) => b.type);
    assert.deepEqual([day(3), day(1)], [['out'], ['in']]);
    // An approved choice is kept, even when someone else ranks higher.
    const approved = planWeek(ctxOf(visits, cleaners, { state: new Map([[a.key, { status: 'approved', assignee_id: 2 }]]) }), WEEK);
    assert.deepEqual([approved.actions[0].kind, approved.actions[0].pick.name, approved.actions[0].state], ['move', 'Com New', 'approved']);
    const held = planWeek(ctxOf(visits, cleaners, { state: new Map([[a.key, { status: 'hold' }]]) }), WEEK);
    assert.equal(held.actions[0].kind, 'hold');
  });

  test('hours, days off, last day, clashes and client wishes all block a move; nobody free = no cover', () => {
    const base = [visit('2026-11-03', 540, 120, [1]), res('2026-11-05', 540, 480, [3]), res('2026-11-06', 540, 480, [3])];
    const target = () => visit('2026-11-17', 600, 120, [3], { customer_id: -500 });
    const kindWith = (c1, extra = [], opts = {}) => planWeek({ ...ctxOf([...base, ...extra, target()], [c1, cleaner(3, 'Res Holder')], opts), ...(opts.ctx || {}) }, WEEK).actions[0].kind;
    assert.equal(kindWith(cleaner(1, 'Com')), 'move');
    assert.equal(kindWith(cleaner(1, 'Com', { availability: hours('08:00', '17:00', [1, 3, 4, 5]) })), 'nocover'); // Tuesday off
    assert.equal(kindWith(cleaner(1, 'Com', { availability: hours('12:00', '17:00') })), 'nocover'); // starts after the visit
    assert.equal(kindWith(cleaner(1, 'Com', { assignable: false })), 'nocover');
    assert.equal(kindWith(cleaner(1, 'Com'), [visit('2026-11-17', 660, 120, [1])]), 'nocover'); // already booked then
    assert.equal(kindWith(cleaner(1, 'Com'), [visit('2026-11-17', 480, 110, [1], P.far)]), 'nocover'); // can't get there in time
    assert.equal(kindWith(cleaner(1, 'Com'), [], { lastDay: new Map([[1, '2026-11-16']]) }), 'nocover');
    assert.equal(kindWith(cleaner(1, 'Com', { gender: 'M' }), [], { ctx: { prefsFor: () => ({ femaleOnly: true, avoid: [] }) } }), 'nocover');
    assert.equal(kindWith(cleaner(1, 'Com'), [], { ctx: { prefsFor: () => ({ avoid: ['com'] }) } }), 'nocover');
    // Recruitment sizing: two uncovered visits at the same time need two more people that day.
    const plan = planWeek(ctxOf([...base, target(), visit('2026-11-17', 630, 120, [3], { customer_id: -501 })], [cleaner(1, 'Com', { assignable: false }), cleaner(3, 'Res Holder')]), WEEK);
    assert.deepEqual([plan.totals.nocover, plan.peak, plan.totals.nocover_hours], [2, { Tue: 2 }, 4]);
  });

  test("the client's gender wish ranks first; a gender entered in the portal replaces Launch27's", () => {
    const visits = [
      visit('2026-11-03', 540, 120, [1]), // 1 has served Carefor (would win on "knows the account")
      visit('2026-11-04', 540, 120, [2], { partner_name: 'OWCS Homemaking', services: ['OWCS Homemaking'] }),
      res('2026-11-05', 540, 480, [3]), res('2026-11-06', 540, 480, [3]),
      visit('2026-11-17', 600, 120, [3], { customer_id: -500 }),
    ];
    const cleaners = [cleaner(1, 'Knows Him', { gender: 'M' }), cleaner(2, 'New Her', { gender: null }), cleaner(3, 'Res Holder')];
    const prefs = (p) => ({ prefsFor: () => ({ avoid: [], ...p }) });
    const pick = (cs, p = {}, details) => {
      const list = details ? withDetails(cs, details) : cs;
      const a = planWeek({ ...ctxOf(visits, list), ...prefs(p) }, WEEK).actions[0];
      return [a.pick.name, a.candidates.map((c) => c.gender_fit)];
    };
    // No wish: knowing the account wins, and no gender fit is shown.
    assert.deepEqual(pick(cleaners), ['Knows Him', [null, null]]);
    // Wants a female cleaner: unknown gender beats the wrong one.
    assert.deepEqual(pick(cleaners, { prefersFemale: true }), ['New Her', ['unknown', 'other']]);
    // The lead enters "F" for cleaner 2 in the portal: now a match.
    const details = new Map([[2, { gender: 'F' }]]);
    assert.deepEqual(pick(cleaners, { prefersFemale: true }, details), ['New Her', ['match', 'other']]);
    const mine = withDetails(cleaners, details);
    assert.deepEqual([mine[1].gender, mine[1].gender_launch27, mine[1].gender_set, cleaners[1].gender], ['F', null, true, null]); // the snapshot is untouched
    const team = teamStats({ visits, cleaners: mine, today: TODAY, isCom });
    assert.deepEqual(team.map((t) => [t.name, t.gender, t.gender_source]).sort(), [['Knows Him', 'M', 'launch27'], ['New Her', 'F', 'platform'], ['Res Holder', 'F', 'launch27']]);
    assert.deepEqual([genderWanted({ femaleOnly: true }), genderWanted({ prefersMale: true }), genderWanted(null), genderRank('F', 'M'), genderRank(null, 'M')], ['F', 'M', null, 2, 0]);
  });

  test('"NO male cleaner" in Staff Notes or a tag means a female cleaner', () => {
    assert.deepEqual(noteHints('11/02/2026: NO MALE cleaner please'), ['prefers female cleaner']);
    assert.deepEqual(noteHints('Female cleaner requested'), ['prefers female cleaner']);
    assert.deepEqual(noteHints('Male cleaner requested'), ['prefers male cleaner']);
    const p = customerPrefs(['No male cleaner']);
    assert.deepEqual([p.prefersFemale, p.prefersMale], [true, false]);
    assert.equal(customerPrefs(['Prefers male cleaner']).prefersMale, true);
  });

  test('transition-program clients stay with their cleaner until the program ends', () => {
    const cleaners = [cleaner(1, 'Com'), cleaner(3, 'Res Holder')];
    const prog = { partner_kind: 'program', partner_name: 'Montfort at Home', services: ['Homemaking (MFT @ Home)'], customer_id: -700 };
    const visits = [visit('2026-11-03', 540, 120, [1]), res('2026-11-05', 540, 480, [3]), res('2026-11-06', 540, 480, [3]), visit('2026-11-17', 600, 120, [3], prog)];
    const plan = planWeek(ctxOf(visits, cleaners), WEEK);
    assert.deepEqual([plan.actions[0].kind, plan.actions[0].category], ['stay', 'Transition programs']);
    const key = plan.actions[0].key;
    // The program ended before this week: plan it like any other visit.
    assert.equal(planWeek(ctxOf(visits, cleaners, { state: new Map([[key, { status: 'proposed', ends_on: '2026-11-13' }]]) }), WEEK).actions[0].kind, 'move');
    assert.equal(planWeek(ctxOf(visits, cleaners, { settings: { ...DEFAULT_SETTINGS, transitionRule: false } }), WEEK).actions[0].kind, 'move');
  });

  test('visits with no cleaner get the nearest free Commercial cleaner; problems are listed', () => {
    const cleaners = [cleaner(1, 'Com Near'), cleaner(2, 'Com Far'), cleaner(4, 'Com Off', { availability: hours('08:00', '17:00', [1, 3, 4, 5]) })];
    const visits = [
      visit('2026-11-03', 540, 120, [1]), visit('2026-11-03', 540, 120, [2]), visit('2026-11-03', 540, 120, [4]),
      visit('2026-11-17', 480, 110, [1], P.b), visit('2026-11-17', 480, 60, [2], P.far),
      visit('2026-11-17', 660, 120, [], { customer_id: -900, customer: 'New Client' }),
      visit('2026-11-17', 540, 120, [4]), // booked on a day off
      visit('2026-11-18', 540, 120, [1]), visit('2026-11-18', 600, 120, [1], { customer_id: -901 }), // double-booked
    ];
    const plan = planWeek(ctxOf(visits, cleaners), WEEK);
    assert.equal(plan.totals.unassigned, 1);
    assert.deepEqual(plan.unassigned[0].commercial.map((c) => c.name), ['Com Near', 'Com Far']);
    assert.ok(plan.unassigned[0].commercial[0].near.km < plan.unassigned[0].commercial[1].near.km);
    assert.deepEqual(plan.off.map((o) => [o.cleaner.name, o.why]), [['Com Off', 'Day off']]);
    assert.deepEqual(plan.clashes.map((c) => c.cleaner.name), ['Com Near']);
    assert.equal(plan.no_cleaner[0].try.startsWith('Com Near'), true);
  });

  test('open slots: free every week, booked some weeks, never outside hours; suggestions favour nearby visits', () => {
    const cleaners = [cleaner(1, 'Ann'), cleaner(2, 'Bea', { availability: hours('08:00', '12:00') })];
    const visits = [
      visit('2026-11-03', 540, 120, [1]), visit('2026-11-03', 540, 120, [2]),
      visit('2026-11-17', 540, 120, [1], P.b), // Ann: Tuesday 9:00 booked in week 1 only
      visit('2026-11-19', 480, 30, [2], P.b), // Bea: Thursday visit ending 8:30
    ];
    const ctx = ctxOf(visits, cleaners);
    const data = computeSlots(ctx, { startWeek: WEEK, weeks: 2, days: [0, 1, 2, 3, 4], slots: DEFAULT_SETTINGS.partner.slots });
    const opt = (name, day, slot) => data.options.find((o) => o.cleaner === name && o.day === day && o.slot === slot);
    assert.deepEqual(opt('Ann', 1, 0).weeks.map((w) => [w.free, w.why]), [[false, 'booked'], [true, '']]);
    assert.deepEqual(opt('Ann', 1, 1).weeks.map((w) => w.free), [true, true]); // 11:30 is exactly 30 minutes after the 9–11 visit
    assert.deepEqual(opt('Ann', 1, 2).weeks.map((w) => w.free), [true, true]);
    assert.deepEqual(opt('Bea', 0, 0).weeks.map((w) => w.free), [true, true]);
    assert.deepEqual(opt('Bea', 0, 1).weeks.map((w) => w.why), ['not working', 'not working']); // ends at noon
    assert.equal(opt('Bea', 3, 0).weeks[0].prev.t, 510);
    const sug = suggestSlots(data, { place: P.b, freq: 1 });
    // Nearest existing visit first: the slots right after a visit at the same place lead.
    assert.deepEqual([sug[0].cleaner, sug[0].day, sug[0].near.km < 1, sug[0].missing], ['Ann', 1, true, []]);
    assert.ok(sug.some((x) => x.cleaner === 'Bea' && x.day === 3 && x.start === 540 && x.near.km < 1));
    assert.ok(sug.findIndex((x) => x.near?.km < 1) < sug.findIndex((x) => !x.near)); // slots with no visit nearby rank last
    assert.ok(suggestSlots(data, { place: P.b, freq: 1, day: 1 }).every((s) => s.day === 1));
    assert.ok(suggestSlots(data, { place: P.b, freq: 0 }).length > 0);
  });

  test('a partner file only carries what the settings allow', () => {
    const cleaners = [cleaner(1, 'Ann Secret')];
    const visits = [visit('2026-11-03', 540, 120, [1]), visit('2026-11-17', 480, 30, [1], { addr: '12 Own Client Rd' }), visit('2026-11-17', 780, 60, [1], { addr: '99 Other Partner Ave', partner_name: 'OWCS Homemaking', services: ['OWCS Homemaking'] }), res('2026-11-18', 480, 30, [1])];
    const data = computeSlots(ctxOf(visits, cleaners), { startWeek: WEEK, weeks: 1, days: [1, 2], slots: [[540, 120]] });
    const cfg = { ...DEFAULT_SETTINGS.partner, generated: TODAY, fsaOf: nearestFsa };
    const text = JSON.stringify(partnerSnapshot(data, 'Carefor', cfg));
    assert.ok(text.includes('Cleaner A') && !text.includes('Ann Secret'));
    assert.ok(text.includes('12 Own Client Rd') && !text.includes('99 Other Partner Ave') && !text.includes('OWCS'));
    assert.ok(!text.includes('45.4') && !/"lat"|"lng"/.test(text)); // places leave only as postal areas
    const owcs = JSON.stringify(partnerSnapshot(data, 'OWCS', cfg));
    assert.ok(owcs.includes('99 Other Partner Ave') && !owcs.includes('12 Own Client Rd'));
    const open = JSON.stringify(partnerSnapshot(data, 'Carefor', { ...cfg, showNames: true, showOtherPartners: true, showOwnAddresses: false }));
    assert.ok(open.includes('Ann Secret') && open.includes('99 Other Partner Ave') && !open.includes('12 Own Client Rd'));
    assert.deepEqual([fsaOfPostal('k1c 2b3'), fsaOfPostal('Z9Z 9Z9'), fsaOfPostal('nonsense')], ['K1C', '', '']);
  });
});

describe('commercial workforce: the app on the synthetic Launch27', () => {
  const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
  const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo', ADMIN_EMAILS: 'boss@example.com' });
  const Q = 'locations=167,168&cornwall=168';
  let db;
  let server;
  let base;
  const login = async (email) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo' }) })).headers.get('set-cookie').split(';')[0];
  const call = async (cookie, path, body, method = body ? 'PUT' : 'GET') => {
    const r = await fetch(`${base}/api/commercial/workforce${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, body: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };

  before(async () => {
    db = await openDb();
    await seed(db);
    const mock = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl: mock, log: quiet });
    const commercialPlan = createWorkforce({ db, schedule });
    server = createApp(config, { db, fetchImpl: mock, schedule, commercialPlan, log: quiet }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    const admin = await login('boss@example.com');
    // Before the planner has loaded Launch27, the plan says so instead of showing nothing.
    assert.equal((await call(admin, `/plan?${Q}`)).status, 409);
    await schedule.sync();
  });
  after(async () => {
    server.closeAllConnections();
    server.close();
    await db.close();
  });

  test('team, plan and slots from live planner data; choices are saved', async () => {
    const admin = await login('boss@example.com');
    assert.equal((await call(admin, '/plan')).status, 400); // no Commercial locations given
    const team = (await call(admin, `/team?${Q}`)).body;
    assert.ok(team.cleaners.some((c) => c.commercial) && team.cleaners.some((c) => !c.commercial));
    const plan = (await call(admin, `/plan?${Q}`)).body;
    assert.ok(plan.totals.visits > 0 && plan.board.length > 0 && plan.load.length === plan.totals.team);
    assert.equal(plan._busy, undefined);
    assert.ok(plan.actions.every((a) => a.kind === 'stay') && plan.totals.stay > 0); // sample data: only programs sit outside the team
    // Tick someone off the team: their Commercial visits now need a move or have no cover.
    const off = team.cleaners.find((c) => c.commercial && c.upcoming_commercial > 0);
    assert.equal((await call(admin, `/cleaners/${off.id}`, { commercial: false })).status, 200);
    const after = (await call(admin, `/plan?${Q}`)).body;
    assert.ok(after.totals.move + after.totals.nocover > 0);
    const a = after.actions.find((x) => x.kind === 'move' || x.kind === 'nocover');
    assert.equal((await call(admin, '/moves', { key: a.key, status: 'hold' })).status, 200);
    assert.equal((await call(admin, `/plan?${Q}`)).body.actions.find((x) => x.key === a.key).kind, 'hold');
    assert.equal((await call(admin, '/moves', { key: 'x; DROP TABLE', status: 'hold' })).status, 404);
    assert.equal((await call(admin, '/moves', { key: a.key, status: 'nonsense' })).status, 400);
    await call(admin, `/cleaners/${off.id}`, { commercial: null }); // back to the suggestion
    assert.equal((await call(admin, `/team?${Q}`)).body.cleaners.find((c) => c.id === off.id).commercial, true);
    const slots = (await call(admin, `/slots?${Q}&postal=K1C%202B3&freq=1`)).body;
    assert.deepEqual([slots.weeks.length, slots.placed.fsa, slots.grid.length], [4, 'K1C', 3]);
    assert.ok(Array.isArray(slots.suggestions));
    assert.equal((await call(admin, `/slots?${Q}&postal=12345`)).status, 400);
  });

  test('cleaner details: gender, home postal code and pets are saved in the portal', async () => {
    const admin = await login('boss@example.com');
    const team = (await call(admin, `/team?${Q}`)).body;
    const c = team.cleaners[0];
    assert.equal((await call(admin, `/cleaners/${c.id}`, { gender: 'M', home_postal: 'k1c2b3', pets_dogs: 'no', pets_cats: 'ok', pets_note: '  allergic to cats? ask first ' })).status, 200);
    let row = (await call(admin, `/team?${Q}`)).body.cleaners.find((x) => x.id === c.id);
    assert.deepEqual([row.gender, row.gender_source, row.home_postal, row.home_fsa, row.pets], ['M', 'platform', 'K1C 2B3', 'K1C', { dogs: 'no', cats: 'ok', other: null, note: 'allergic to cats? ask first' }]);
    assert.ok(row.home_place);
    // The audit log keeps only the postal area, never the full code.
    const audit = (await db.query("SELECT detail FROM audit_log WHERE action = 'commercial.cleaner' ORDER BY id DESC LIMIT 1")).rows[0];
    const logged = JSON.stringify(audit?.detail ?? '');
    assert.ok(logged.includes('K1C') && !/2B3/i.test(logged));
    // Clearing goes back to Launch27's code.
    assert.equal((await call(admin, `/cleaners/${c.id}`, { gender: null, home_postal: '' })).status, 200);
    row = (await call(admin, `/team?${Q}`)).body.cleaners.find((x) => x.id === c.id);
    assert.deepEqual([row.gender_source === 'platform', row.home_postal, row.pets.dogs], [false, null, 'no']);
    for (const bad of [{ gender: 'X' }, { home_postal: '12345' }, { pets_dogs: 'maybe' }]) assert.equal((await call(admin, `/cleaners/${c.id}`, bad)).status, 400);
    assert.deepEqual([tidyPostal('k1c 2b3'), tidyPostal('K6H'), tidyPostal('90210')], ['K1C 2B3', 'K6H', null]);
    // Details never reach a partner file.
    await call(admin, `/cleaners/${c.id}`, { home_postal: 'K2P 0A1', pets_note: 'SECRET-PET-NOTE' });
    const file = await call(admin, `/partner-file?${Q}&partner=Carefor`);
    assert.ok(!file.text.includes('K2P 0A1') && !file.text.includes('SECRET-PET-NOTE'));
  });

  test('partner files: leads only, a standalone page with no cleaner names; settings are for leads', async () => {
    const admin = await login('boss@example.com');
    const agent = await login('agent9@example.com');
    assert.equal((await call(agent, `/partner-file?${Q}&partner=Carefor`)).status, 403);
    assert.equal((await call(agent, '/settings', { partner: { showNames: true } })).status, 403);
    assert.equal((await call(admin, `/partner-file?${Q}&partner=Nobody`)).status, 404);
    const file = await call(admin, `/partner-file?${Q}&partner=Carefor`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /attachment; filename="urbanmop-availability-carefor-\d{4}-\d{2}-\d{2}\.html"/);
    assert.ok(file.text.includes('UrbanMop for') && file.text.includes('"partner":"Carefor"') && !file.text.includes('/*SNAPSHOT*/'));
    const names = (await call(admin, `/team?${Q}`)).body.cleaners.map((c) => c.name);
    assert.ok(names.every((n) => !file.text.includes(n)));
    assert.equal((await call(admin, '/settings', { partner: { weeks: 2, contact: 'commercial@example.com' } })).body.partner.weeks, 2);
    assert.equal((await call(admin, `/slots?${Q}`)).body.weeks.length, 2);
    assert.equal((await call(admin, '/settings', { partner: { weeks: 99 } })).status, 400);
  });
});
