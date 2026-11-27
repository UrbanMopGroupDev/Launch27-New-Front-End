// Complaint Resolution Engine, Phase 1. This repo is public: every name below is made up,
// written in the same formats as the real finance-channel posts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRefundPost, reasonKind } from '../src/complaints/slackRefunds.js';
import { classifyRules, mergeClassification, hardRouteFor, causeRules, causeFacts, CAUSES, CAUSE_GROUPS } from '../src/complaints/taxonomy.js';
import { redact } from '../src/complaints/redact.js';
import { outcomeAt, journeyAt, recleanCost, cleanerLastWorkedIndex, regularCleaner } from '../src/complaints/journey.js';
import { normalizeSettings, canApprove, rungForRefund, budgetStatus, DEFAULT_SETTINGS } from '../src/complaints/settings.js';
import { buildPlaybook } from '../src/complaints/playbook.js';
import { mapStatus, toCase, discover, createKustomerClient, findListing } from '../src/complaints/sources/kustomer.js';
import { createComplaints, buildReviewStats } from '../src/complaints/service.js';
import { createReports } from '../src/reports/service.js';
import { createSchedule } from '../src/schedule/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
const ts = (iso) => String(Date.parse(iso) / 1000);

describe('complaints: Slack refund posts', () => {
  test('percent first, with amount and service date', () => {
    const p = parseRefundPost({ text: '<@U0X|Vincent> please process 40% ($203.71) refund for Tessa Moreau, service date August 7th due to dissatisfaction of the service. Once done, send here the screenshot', ts: ts('2026-08-25T19:11:00Z'), user_name: 'Jose' });
    assert.equal(p.kind, 'complaint');
    assert.equal(p.client_name, 'Tessa Moreau');
    assert.equal(p.pct, 40);
    assert.equal(p.amount, 203.71);
    assert.equal(p.service_date, '2026-08-07');
    assert.equal(p.decided_by, 'Jose');
    assert.equal(p.approved_by, null, 'a request is not an approval');
  });
  test('"Refunded X for 50% -252.17" (no dollar sign) and review mention', () => {
    const p = parseRefundPost({ text: 'Refunded Dana Pike for 50% -252.17 for the negative experience, threatened us for negative Google Review. Updated the booking', ts: ts('2025-05-05T17:47:00Z'), user_name: 'Jose' });
    assert.equal(p.client_name, 'Dana Pike');
    assert.equal(p.pct, 50);
    assert.equal(p.amount, 252.17);
    assert.equal(p.review_related, true);
    assert.equal(p.kind, 'complaint');
    assert.equal(p.approved_by, 'Jose');
  });
  test('full refund, amount on its own line', () => {
    const p = parseRefundPost({ text: 'Hi <@U0X|Vincent>, Please process a full refund for client *Rosa Lind* for the booking below:\n\n*Booking Date/Time:* July 25, 2026, 11:00 AM – 12:00 PM\n*Refund Amount:* $158.65', ts: ts('2026-07-29T18:04:00Z'), user_name: 'Bashar Hamdan' });
    assert.equal(p.client_name, 'Rosa Lind');
    assert.equal(p.pct, 100);
    assert.equal(p.amount, 158.65);
    assert.equal(p.service_date, '2026-07-25');
  });
  test('damage with the cleaner charged half', () => {
    const p = parseRefundPost({ text: 'Update: Refunded Gail Moss for $197.75 for the repair of the sculpture. Deducted the half amount ($98.88) to Amy.', ts: ts('2025-05-19T16:53:00Z'), user_name: 'Jose' });
    assert.equal(p.kind, 'damage');
    assert.equal(p.amount, 197.75);
    assert.equal(p.cleaner_recovery, 98.88);
  });
  test('damage reimbursement with "deduct 50%" is not a 50% refund', () => {
    const p = parseRefundPost({ text: "I'd like to request for $250 reimbursement to be paid to the client's etransfer x@example.com This would be the agreed reimbursement amount for the damaged TV. I've already sent pay adjustment for Sam to deduct 50% of the amount. Client's name is Mira Oakes", ts: ts('2025-11-25T15:24:00Z'), user_name: 'Jose' });
    assert.equal(p.kind, 'damage');
    assert.equal(p.amount, 250);
    assert.equal(p.pct, null);
    assert.equal(p.cleaner_recovery, 125);
  });
  test('cancellations, payment adjustments and questions are not complaints', () => {
    assert.equal(parseRefundPost({ text: 'can you please process a full refund of *$401.04* for Vera Tull for her cancelled booking July 3,2026', ts: ts('2026-07-13T14:35:00Z') }).kind, 'cancellation');
    assert.equal(reasonKind('This is the difference of the amount she paid via affirm vs service amount'), 'billing_adjustment');
    assert.equal(parseRefundPost({ text: 'Hi Jose, could you kindly confirm if the refund for Ian Wu of $49.32 was due to unsatisfactory experience?', ts: ts('2026-01-14T14:31:00Z') }).kind, 'question');
    assert.equal(parseRefundPost({ text: '<@U0X|Vincent> has joined the channel', ts: ts('2026-01-14T14:31:00Z') }), null);
  });
  test('new channel style: approvals by Derek or the GM, partner profiles flagged', () => {
    const a = parseRefundPost({ text: 'Hi, <@U0X|Vincent>. Good afternoon! Please process a partial refund of $140 for *Lena Ortiz’s* November 10 appointment. This refund has been approved by <@U0D|Derek Chiu>. Thank you!', ts: ts('2026-11-12T19:15:00Z'), user_name: 'Grace' });
    assert.equal(a.client_name, 'Lena Ortiz');
    assert.equal(a.amount, 140);
    assert.equal(a.service_date, '2026-11-10');
    assert.equal(a.approved_by, 'Derek Chiu');
    assert.equal(a.decided_by, 'Grace');
    const b = parseRefundPost({ text: 'Please process the *$45.57* refund for Nora Dale’s appointment on November 13. She is Jon Mott’s partner, and they were dissatisfied with the appointment on October 23, which was under Jon’s profile. The refund was approved by the GM as a gesture of goodwill.', ts: ts('2026-11-11T19:10:00Z'), user_name: 'Grace' });
    assert.equal(b.approved_by, 'Jose (GM)');
    assert.equal(b.service_date, '2026-11-13', 'upcoming appointment, same year');
    assert.equal(b.other_profile, true);
    assert.equal(b.kind, 'complaint');
  });
  test('no year written: most recent such date before the post', () => {
    const p = parseRefundPost({ text: 'Fyi 20% refund for Hanna Bell due to unsatisfied with the service | Nov 13 service', ts: ts('2025-01-10T22:41:00Z'), user_name: 'Jose' });
    assert.equal(p.service_date, '2024-11-13');
    assert.equal(p.pct, 20);
  });
});

describe('complaints: taxonomy and hard routes', () => {
  test('quality complaint with areas and tone', () => {
    const c = classifyRules('Really disappointed. The kitchen counters were still dirty and the baseboards were skipped. I will be leaving a review.');
    assert.equal(c.category, 'quality_missed');
    assert.deepEqual(c.areas.sort(), ['baseboards', 'kitchen']);
    assert.equal(c.tone, 'threat_review');
    assert.equal(c.hard_route, null);
  });
  test('hard routes', () => {
    assert.equal(classifyRules('The cleaner broke my TV, it cost $800 to replace').hard_route, 'damage_over_100');
    assert.equal(classifyRules('A small chip on a mug, maybe $10').hard_route, null);
    assert.equal(classifyRules('My ring went missing after the clean').hard_route, 'theft_missing');
    assert.equal(classifyRules('I will be filing a chargeback with my credit card company').hard_route, 'legal_chargeback');
    assert.equal(hardRouteFor({ category: 'quality_missed', text: 'she brought her kids into my home' }), 'misconduct');
  });
  test("a model can't take a case off a hard route", () => {
    const rules = classifyRules('I am calling my lawyer about this');
    const merged = mergeClassification(rules, { category: 'communication', tone: 'angry', severity: 2, areas: [], hard_route: null, summary: 'x', is_complaint: true, confidence: 0.9 });
    assert.equal(merged.hard_route, 'legal_chargeback');
    assert.equal(merged.severity, 4);
    assert.equal(merged.classified_by, 'claude');
  });
});

describe('complaints: redaction before Claude', () => {
  test('names, contacts, addresses and postal codes are removed', () => {
    const out = redact('Hi Sarah,\nThis is Paul Kemp at 123 Bank St, Ottawa K1P 5N2. Call me at (613) 555-0199 or paul@example.com. Maria missed the bathroom.\nThanks,\nPaul', { names: ['Paul Kemp', 'Maria Lopez'] });
    for (const leaked of ['Paul', 'Kemp', 'Maria', '123 Bank', 'K1P', '555-0199', 'paul@example.com']) assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
    assert.match(out, /missed the bathroom/);
  });
});

describe('complaints: outcomes and journey', () => {
  const DAY = 86_400_000;
  const at0 = Date.parse('2026-03-01T15:00:00Z');
  const V = (offsetDays, extra = {}) => ({ id: offsetDays + 1000, at: at0 + offsetDays * DAY, date: new Date(at0 + offsetDays * DAY).toISOString().slice(0, 10), revenue: 180, freq: 'Biweekly', teams: [{ id: 7, name: 'Cleaner 7', hours: 3, earned: 66 }], ...extra });
  const today = at0 + 200 * DAY;
  test('still booking past day 60 = saved', () => {
    const list = [V(-14), V(0), V(14), V(28), V(42), V(56), V(70), V(84)];
    assert.equal(outcomeAt(list, at0 + DAY, 60, { today }).outcome, 'saved');
    assert.equal(outcomeAt(list, at0 + DAY, 30, { today }).outcome, 'pending');
  });
  test('stopped within 60 days = lost; left after 60 = partial save', () => {
    assert.equal(outcomeAt([V(-14), V(0), V(14)], at0 + DAY, 60, { today }).outcome, 'lost');
    assert.equal(outcomeAt([V(0), V(14), V(28), V(42), V(56), V(70)], at0 + DAY, 90, { today }).outcome, 'partial_save');
  });
  test('negative public review = lost even if still booking', () => {
    assert.equal(outcomeAt([V(0), V(80)], at0 + DAY, 60, { today, negativeReview: { stars: 1, platform: 'google' } }).outcome, 'lost');
  });
  test('too recent to tell = pending', () => {
    assert.equal(outcomeAt([V(0), V(14)], at0 + DAY, 60, { today: at0 + 40 * DAY }).outcome, 'pending');
  });
  test('journey: cleaner change and price change', () => {
    const list = [V(-42), V(-28), V(-14, { revenue: 200, teams: [{ id: 9, name: 'Cleaner 9', hours: 3 }] })];
    const j = journeyAt(list, at0, {});
    assert.equal(j.cleaner_changed_last_visit, true);
    assert.equal(j.distinct_cleaners_90d, 2);
    assert.equal(j.cleans_total, 3);
    assert.ok(j.price_change_pct > 0.1);
  });
  test('reclean cost includes the lost slot', () => {
    const c = recleanCost({ hours: 3, cleanerHourly: 22, marginPerHour: 20 }, DEFAULT_SETTINGS.costs);
    assert.equal(c.labour, 66);
    assert.equal(c.lost_slot, 60);
    assert.equal(c.total, 66 + 60 + DEFAULT_SETTINGS.costs.travel_per_visit);
  });
});

describe('complaints: approval rules and budget', () => {
  test('today vs target is a settings change; nobody but the owner goes above 50%', () => {
    const today = normalizeSettings({ roles: { 'om@x.ca': 'office_manager', 'derek@x.ca': 'owner' } });
    assert.equal(canApprove(today, 'om@x.ca', 'L3'), true);
    assert.equal(canApprove(today, 'om@x.ca', 'L4'), false);
    assert.equal(canApprove(today, 'anyone@x.ca', 'L3'), true);
    const target = normalizeSettings({ approval_preset: 'target', roles: { 'om@x.ca': 'office_manager' }, max_rung: { office_manager: 'L7', frontline: 'L7' } });
    assert.equal(canApprove(target, 'om@x.ca', 'L6'), true);
    assert.equal(canApprove(target, 'om@x.ca', 'L7'), false, 'office manager capped at 50%');
    assert.equal(canApprove(target, 'anyone@x.ca', 'L7'), false, 'frontline capped too');
    assert.equal(canApprove(target, 'derek@x.ca', 'L7'), false, 'owner only by role, not by name');
    assert.equal(canApprove(normalizeSettings({ roles: { 'derek@x.ca': 'owner' } }), 'derek@x.ca', 'L7'), true);
  });
  test('historical refund % maps onto rungs', () => {
    assert.deepEqual([20, 30, 40, 50, 100].map(rungForRefund), ['L4', 'L5', 'L5', 'L6', 'L7']);
  });
  test('budget: default target 20% below average, amber at 80%, red at 100%', () => {
    const s = normalizeSettings({});
    assert.equal(budgetStatus({ cost: 100, revenue: 10000 }, s, 0.02).target, 0.016);
    assert.equal(budgetStatus({ cost: 100, revenue: 10000 }, s, 0.02).level, 'green');
    assert.equal(budgetStatus({ cost: 140, revenue: 10000 }, s, 0.02).level, 'amber');
    assert.equal(budgetStatus({ cost: 170, revenue: 10000 }, s, 0.02).level, 'red');
  });
});

describe('complaints: Kustomer mapping', () => {
  test('statuses map to ours and the raw value is kept', () => {
    assert.equal(mapStatus('For Review'), 'open');
    assert.equal(mapStatus('Awaiting Response'), 'awaiting_client');
    assert.equal(mapStatus('Damaged Item'), 'open');
    assert.equal(mapStatus('Reclean Scheduled'), 'reclean_scheduled');
  });
  test('fields are found by name, whatever the org called them', () => {
    const c = toCase({ id: 'k1', attributes: { createdAt: '2026-10-01T12:00:00Z', title: 'Complaint', custom: { statusStr: 'Reclean Scheduled', complaintTypeStr: 'Missed areas', bookingNumberStr: '#74512', resolutionTxt: 'Offered reclean' } }, relationships: { customer: { data: { id: 'c1' } } } });
    assert.equal(c.status, 'reclean_scheduled');
    assert.equal(c.source_status, 'Reclean Scheduled');
    assert.equal(c.l27_booking_id, 74512);
    assert.equal(c.kustomer_customer_id, 'c1');
    assert.match(c.text, /Missed areas/);
  });
  test('discovery returns field names and types, never values', async () => {
    const client = { get: async (path) => (path === '/v1/klasses' ? { data: [{ attributes: { name: 'complaint', displayName: 'Complaint' } }, { attributes: { name: 'order' } }] } : { data: [{ attributes: { createdAt: 'x', custom: { statusStr: 'For Review', detailsTxt: 'secret client text' } } }] }) };
    const d = await discover(client);
    assert.equal(d.complaint_klass, 'complaint');
    assert.ok(d.fields.some((f) => f.name === 'custom.detailsTxt' && f.type === 'string'));
    assert.ok(!JSON.stringify(d).includes('secret client text'));
  });
});

describe('complaints: playbook', () => {
  test('rungs, retention, reclean vs refund, thin data flagged', () => {
    const cases = [];
    const resolutions = [];
    const costs = [];
    const outcomes = [];
    let id = 1;
    const add = (category, { rung, action, cost, outcome }) => {
      const c = { id: id++, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category, l27_customer_id: id, classified_by: 'claude' };
      cases.push(c);
      if (rung) resolutions.push({ case_id: c.id, rung, action });
      if (cost) costs.push({ case_id: c.id, kind: action === 'refund' ? 'refund' : 'reclean_labour', amount: cost, estimated: false });
      outcomes.push({ case_id: c.id, day: 60, outcome });
    };
    for (let i = 0; i < 4; i++) add('quality_missed', { rung: 'L3', action: 'reclean_full', cost: 120, outcome: i < 3 ? 'saved' : 'lost' });
    for (let i = 0; i < 4; i++) add('quality_missed', { rung: 'L5', action: 'refund', cost: 50, outcome: i < 3 ? 'saved' : 'lost' });
    for (let i = 0; i < 3; i++) add('quality_missed', { outcome: 'lost' });
    const pb = buildPlaybook({ cases, resolutions, costs, outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-16' });
    const q = pb.taxonomy.find((t) => t.key === 'quality_missed');
    assert.equal(q.n, 11);
    assert.equal(q.confidence, 'fair');
    assert.equal(q.cheapest_that_works.rung, 'L5', '25%-ish refund kept as many as a reclean for less');
    const l3 = pb.ladder.find((r) => r.rung === 'L3');
    assert.equal(l3.n, 4);
    assert.equal(l3.confidence, 'thin');
    const rv = pb.reclean_vs_refund.find((x) => x.key === 'quality_missed');
    assert.match(rv.verdict, /reclean|refund/);
    assert.ok(pb.gaps.length >= 1);
  });
});

describe('complaints: end to end on the synthetic Launch27', () => {
  test('a run finds unhappy ratings, links bookings, computes journeys, outcomes and the playbook', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const snap = await reports.visitsSnapshot();
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    const to = snap.to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const result = await complaints.run({ from, to });
    assert.ok(result.cases > 0, 'unhappy ratings become cases');
    const list = await complaints.listCases({ from, to });
    assert.ok(list.every((c) => c.source === 'launch27_rating'), 'no real sources outside production');
    const one = await complaints.getCase(list[0].id);
    assert.ok(one.l27_booking_id);
    assert.ok(one.journey && one.journey.cleans_total >= 1);
    assert.equal(one.outcomes.length, 3);
    // Re-running is idempotent.
    await complaints.run({ from, to });
    assert.equal((await complaints.listCases({ from, to })).length, list.length);
    const pb = await complaints.playbook({ from, to });
    assert.equal(pb.totals.cases, list.length);
    assert.ok(pb.root_causes && pb.root_causes.visits > 0);
    assert.ok(pb.baseline.months.length > 0);
    const st = await complaints.status();
    assert.equal(st.last_run.status, 'done');
    assert.match(st.sources.kustomer, /not set up/);
    await db.close();
  });
});

describe('complaints: production without a Launch27 sync login', () => {
  test("a run builds the Launch27 history with the admin's own login", async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    await schedule.sync();
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await assert.rejects(() => reports.visitsSnapshot(), /not been built/);
    const login = await (await fetchImpl(`${config.l27BaseUrl}/latest/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'demo' }) })).json();
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
    const r = await complaints.run({ from, to, bearer: login.bearer });
    assert.ok(r.cases >= 0);
    const st = await complaints.status();
    assert.equal(st.last_run.status, 'done');
    assert.ok(st.last_run.log.some((l) => /building it now/.test(l.msg)));
    await db.close();
  });
});

describe('complaints: Kustomer listing fallbacks', () => {
  const res = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
  test('a refused listing shape falls through to the next, and Kustomer\'s reason is kept', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname + u.search);
      if (u.pathname === '/v1/klasses') return res(200, { data: [{ id: 'k123', attributes: { name: 'complaint' } }] });
      if (u.pathname === '/v1/klasses/complaint') return res(400, { errors: [{ title: 'Bad Param', detail: 'badparam' }] });
      if (u.pathname === '/v1/klasses/complaint/kobjects') return res(400, { errors: [{ title: 'Bad Request', detail: 'use the klass id, not name (ask a@b.com)' }] });
      if (u.pathname === '/v1/klasses/k123/kobjects') return res(200, { data: [{ id: 'o1', attributes: { createdAt: '2026-10-01T00:00:00Z', custom: { statusStr: 'For Review' } } }], links: { next: null } });
      return res(404, {});
    };
    const client = createKustomerClient({ apiKey: 'x', fetchImpl, sleep: async () => {} });
    const d = await discover(client);
    assert.equal(d.listing.label, 'by id');
    assert.equal(d.attempts.length, 4);
    assert.match(d.attempts[1].error, /400 \(Bad Request: use the klass id/);
    assert.ok(!JSON.stringify(d).includes('a@b.com'), 'emails masked in error text');
    assert.equal(d.sample_count, 1);
  });
  test('when nothing works, every attempt says why', async () => {
    const fetchImpl = async () => res(403, { errors: [{ title: 'Forbidden', detail: 'missing org.permission.kobject.read' }] });
    const client = createKustomerClient({ apiKey: 'x', fetchImpl, sleep: async () => {} });
    const f = await findListing(client, { id: 'k1', name: 'complaint' });
    assert.equal(f.listing, null);
    assert.ok(f.attempts.every((a) => /403 \(Forbidden: missing org.permission.kobject.read\)/.test(a.error)));
  });
});

describe('complaints: Kustomer documented listing', () => {
  test('GET /v1/klasses/{name} is used first, and links.next is followed', async () => {
    const res = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
    const seen = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      seen.push(u.pathname + u.search);
      if (u.pathname === '/v1/klasses') return res(200, { data: [{ id: 'k1', attributes: { name: 'complaint' } }] });
      if (u.pathname === '/v1/klasses/complaint' && !u.search) return res(200, { data: [{ id: 'a', attributes: { createdAt: '2026-10-01T00:00:00Z', custom: {} } }], links: { next: '/v1/klasses/complaint?page=2' } });
      if (u.pathname === '/v1/klasses/complaint' && u.search === '?page=2') return res(200, { data: [{ id: 'b', attributes: { createdAt: '2026-10-05T00:00:00Z', custom: {} } }], links: { next: null } });
      return res(400, { errors: [{ title: 'Bad Param' }] });
    };
    const client = createKustomerClient({ apiKey: 'x', fetchImpl, sleep: async () => {} });
    const d = await discover(client);
    assert.equal(d.listing.label, 'documented');
    const { listComplaints } = await import('../src/complaints/sources/kustomer.js');
    const ids = [];
    for await (const o of listComplaints(client, d.listing, { from: '2026-09-01', to: '2026-10-31' })) ids.push(o.id);
    assert.deepEqual(ids, ['a', 'b']);
  });
});

describe('complaints: info@ email by month', () => {
  test('a month whose search keeps timing out is skipped; the other months are still read', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    let searches = 0;
    const b64 = (s) => Buffer.from(s).toString('base64url');
    const client = {
      async search(account, q) {
        searches++;
        if (/after:2026\/09\/01/.test(q)) throw new Error('The operation was aborted due to timeout');
        const m = q.match(/after:(\d{4})\/(\d\d)/);
        return { ids: [`m-${m[1]}-${m[2]}`], next: null };
      },
      async message(account, id) {
        return { id, threadId: `t-${id}`, internalDate: String(Date.parse('2026-09-15T12:00:00Z')), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Pat Client <pat@example.com>' }, { name: 'Subject', value: 'Very disappointed' }], body: { data: b64('The kitchen was still dirty and the floors were missed. Unacceptable.') } } };
      },
    };
    const complaints = createComplaints({ db, config, reports, fetchImpl, gmail: { client, accounts: ['info@example.com'] }, log: quiet });
    await complaints.run({ from: '2026-08-01', to: '2026-10-31' });
    const st = await complaints.status();
    const msgs = st.last_run.log.map((l) => l.msg);
    assert.ok(msgs.some((m) => /2026\/09\/01.*skipped/.test(m)), 'the bad month is reported');
    assert.ok(msgs.some((m) => /info@ email: [1-9]\d* candidate threads.*1 month\(s\) skipped/.test(m)), msgs.join(' | '));
    assert.ok(searches >= 4, 'the bad month was retried once and the other months still searched');
    await db.close();
  });
});

describe('complaints: cut-off runs', () => {
  test('a run left running by a restart is marked interrupted; what it saved stays', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    const snap = await reports.visitsSnapshot();
    const from = new Date(Date.parse(snap.to) - 182 * 86_400_000).toISOString().slice(0, 10);
    await complaints.run({ from, to: snap.to });
    const saved = (await complaints.listCases({ from, to: snap.to })).length;
    assert.ok(saved > 0);
    // Simulate a restart mid-run: a run row left 'running'.
    await db.query("INSERT INTO complaint_runs (window_from, window_to, status, log) VALUES ($1, $2, 'running', '[]')", [from, snap.to]);
    assert.equal(await complaints.markInterrupted(), 1);
    const st = await complaints.status();
    assert.equal(st.last_run.status, 'interrupted');
    assert.match(st.last_run.log.at(-1).msg, /Interrupted/);
    assert.equal((await complaints.listCases({ from, to: snap.to })).length, saved, 'saved cases are kept');
    assert.equal(await complaints.markInterrupted(), 0, 'nothing left to mark');
    assert.ok((await db.query('SELECT log FROM complaint_runs WHERE id = (SELECT min(id) FROM complaint_runs)')).rows[0].log.some((l) => /Launch27 ratings: \d+ complaint cases? saved/.test(l.msg)), 'each source reports what it saved');
    await db.close();
  });
});

describe('complaints: faster classification', () => {
  test('info@ is screened by rules before Claude, and Claude calls run several at a time', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const b64 = (s) => Buffer.from(s).toString('base64url');
    const bodies = { a: 'The kitchen was still dirty and the floors were missed. Unacceptable.', b: 'Hi, can we move Tuesday to Wednesday? Thanks', c: 'Really disappointed, the bathroom was skipped again.' };
    const client = {
      async search(account, q) {
        return /after:2026\/10\/01/.test(q) ? { ids: ['a', 'b', 'c'], next: null } : { ids: [], next: null };
      },
      async message(account, id) {
        return { id, threadId: `t-${id}`, internalDate: String(Date.parse('2026-10-05T12:00:00Z')), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `Client ${id} <${id}@example.com>` }, { name: 'Subject', value: 'Cleaning' }], body: { data: b64(bodies[id]) } } };
      },
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const seen = [];
    const classifier = async (text) => {
      seen.push(text);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { is_complaint: true, category: 'quality_missed', tone: 'frustrated', severity: 2, areas: [], hard_route: null, summary: 'x', confidence: 0.9 };
    };
    const complaints = createComplaints({ db, config, reports, fetchImpl, gmail: { client, accounts: ['info@example.com'] }, classifier, log: quiet });
    await complaints.run({ from: '2026-10-01', to: '2026-10-31' });
    assert.ok(!seen.some((t) => /move Tuesday/.test(t)), 'a scheduling email never reaches Claude');
    assert.ok(seen.some((t) => /bathroom was skipped/.test(t)));
    assert.ok(maxInFlight > 1, 'Claude calls overlap');
    const st = await complaints.status();
    assert.ok(st.last_run.log.some((l) => /info@ email: 2 complaint cases saved \(1 screened out/.test(l.msg)), st.last_run.log.map((l) => l.msg).join(' | '));
    await db.close();
  });
});

describe('complaints: one-time clients, service type, clients view', () => {
  const DAY = 86_400_000;
  const at0 = Date.parse('2026-03-01T15:00:00Z');
  const V = (d, extra = {}) => ({ id: d + 5000, at: at0 + d * DAY, date: new Date(at0 + d * DAY).toISOString().slice(0, 10), revenue: 250, kind: 'one', teams: [{ id: 7, name: 'C7', hours: 4 }], ...extra });
  test('one-time client: rebooked within 90/120 days, or not, or too early', async () => {
    const { oneTimeOutcomeAt } = await import('../src/complaints/journey.js');
    const today = at0 + 200 * DAY;
    assert.equal(oneTimeOutcomeAt([V(0), V(70)], at0, 90, { today }).outcome, 'rebooked');
    assert.equal(oneTimeOutcomeAt([V(0), V(110)], at0, 90, { today }).outcome, 'not_rebooked');
    assert.equal(oneTimeOutcomeAt([V(0), V(110)], at0, 120, { today }).outcome, 'rebooked');
    assert.equal(oneTimeOutcomeAt([V(0)], at0, 120, { today }).outcome, 'not_rebooked');
    assert.equal(oneTimeOutcomeAt([V(0)], at0, 120, { today: at0 + 50 * DAY }).outcome, 'pending');
  });
  test('visit snapshot carries service type; deep clean and move in/out come from extras', async () => {
    const { slimReportVisit } = await import('../src/reports/compute.js');
    const b = { id: 1, service_date: '2026-10-05T14:00:00Z', frequency: { name: 'One time' }, user: { id: 3, name: 'A' }, summary: { revenue: 300 }, teams: [{ id: 7, title: 'C', hours: 4 }], services: [{ name: 'Three Bedroom Home', extras: [{ name: 'Deep Cleaning' }, { name: 'Inside Oven' }] }] };
    const v = slimReportVisit(b, null, null);
    assert.equal(v.svc, 'Three Bedroom Home');
    assert.equal(v.deep, true);
    assert.equal(v.move, false);
    assert.equal(slimReportVisit({ ...b, services: [{ name: 'Reclean', extras: [] }] }, null, null).reclean, true);
  });
  test('playbook: one-time clients are measured on rebooking, not Saved/Lost; plain rung names', () => {
    const cases = [
      { id: 1, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', l27_customer_id: 1, one_time: true },
      { id: 2, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', l27_customer_id: 2, one_time: true },
      { id: 3, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', l27_customer_id: 3 },
    ];
    const outcomes = [{ case_id: 1, day: 120, outcome: 'rebooked' }, { case_id: 2, day: 120, outcome: 'not_rebooked' }, { case_id: 3, day: 60, outcome: 'saved' }];
    const pb = buildPlaybook({ cases, resolutions: [{ case_id: 3, rung: 'L3', action: 'reclean_full' }], costs: [], outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-16' });
    assert.equal(pb.totals.decided, 1, 'only the recurring client counts toward Saved/Lost');
    assert.equal(pb.totals.saved, 1);
    assert.equal(pb.totals.one_time.n, 2);
    assert.equal(pb.totals.one_time.rebooked_120, 0.5);
    assert.equal(pb.ladder.find((r) => r.rung === 'L3').name, 'Reclean');
    assert.equal(pb.ladder.find((r) => r.rung === 'L0').name, 'Apology only');
    assert.ok(pb.like_for_like.verdict);
  });
  test('like for like: only groups with both a reclean and a refund are compared', () => {
    const cases = [];
    const resolutions = [];
    const outcomes = [];
    let id = 1;
    const add = (tone, action, outcome) => {
      cases.push({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', tone, tenure_days: 200, l27_customer_id: id });
      resolutions.push({ case_id: id, rung: action === 'refund' ? 'L5' : 'L3', action: action === 'refund' ? 'refund' : 'reclean_full' });
      outcomes.push({ case_id: id++, day: 60, outcome });
    };
    // Calm clients: recleans only (no refund to compare with). Heated: both.
    for (let i = 0; i < 8; i++) add('mild', 'reclean', 'saved');
    for (let i = 0; i < 6; i++) add('angry', 'reclean', i < 2 ? 'saved' : 'lost');
    for (let i = 0; i < 6; i++) add('angry', 'refund', i < 4 ? 'saved' : 'lost');
    const pb = buildPlaybook({ cases, resolutions, costs: [], outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-16' });
    const l = pb.like_for_like;
    assert.equal(l.groups_compared, 1);
    assert.equal(l.matched_pairs, 6);
    assert.equal(l.reclean.saved, 0.333);
    assert.equal(l.refund.saved, 0.667);
    assert.match(l.verdict, /Too few comparable cases/);
  });
  test('clients view: repeat complainers and at-risk clients, with reasons', async () => {
    const { buildClients } = await import('../src/complaints/playbook.js');
    const now = Date.parse('2026-11-16T12:00:00Z');
    const day = (d) => new Date(now - d * DAY).toISOString();
    const rows = [
      { id: 1, l27_customer_id: 10, customer_name: 'A', opened_at: day(200), category: 'quality_missed', tone: 'mild', severity: 1, cost: 5, outcomes: [{ day: 60, outcome: 'saved', next: '2026-06-01' }] },
      { id: 2, l27_customer_id: 10, customer_name: 'A', opened_at: day(100), category: 'quality_missed', tone: 'mild', severity: 1, cost: 10, outcomes: [{ day: 60, outcome: 'saved', next: '2026-09-01' }] },
      { id: 3, l27_customer_id: 20, customer_name: 'B', opened_at: day(20), category: 'punctuality', tone: 'threat_leave', severity: 3, cost: 0, cleans_total: 2, outcomes: [{ day: 30, outcome: 'pending', next: null }] },
      { id: 4, l27_customer_id: 30, customer_name: 'C', opened_at: day(20), category: 'quality_missed', tone: 'mild', severity: 1, cost: 0, cleans_total: 40, outcomes: [{ day: 30, outcome: 'pending', next: '2026-11-20' }] },
      { id: 5, l27_customer_id: 40, customer_name: 'D', opened_at: day(150), category: 'quality_missed', tone: 'threat_review', severity: 3, cost: 80, outcomes: [{ day: 60, outcome: 'lost', next: null }] },
    ];
    const c = buildClients(rows, now);
    assert.deepEqual(c.repeat.map((x) => x.name), ['A']);
    assert.equal(c.repeat[0].complaints, 2);
    assert.equal(c.repeat[0].total_cost, 15);
    assert.equal(c.repeat[0].still_with_us, true);
    assert.deepEqual(c.at_risk.map((x) => x.name), ['B'], 'calm long-time client with a booking ahead is not at risk; a lost client is not at risk');
    assert.ok(c.at_risk[0].reasons.includes('said they may leave'));
    assert.ok(c.at_risk[0].reasons.includes('nothing booked since the complaint'));
    assert.deepEqual(c.review_mentions.map((x) => x.name), ['D']);
    assert.equal(c.google_reviews_connected, false);
  });
});

describe('complaints: automatic updates', () => {
  test('plan: newest unread days first, then older months, then the daily refresh, then nothing', async () => {
    const { planAuto } = await import('../src/complaints/service.js');
    const today = '2026-11-19';
    // Nothing read yet: the most recent month.
    let j = planAuto({ mined: [], today, historyDays: 365, recentDone: null });
    assert.deepEqual([j.kind, j.from, j.to], ['history', '2026-10-19', '2026-11-18']);
    // Aug 15 – Nov 15 read: first catch up the days since.
    j = planAuto({ mined: [{ from: '2026-08-15', to: '2026-11-15' }], today, historyDays: 365, recentDone: null });
    assert.deepEqual([j.kind, j.from, j.to], ['history', '2026-11-16', '2026-11-18']);
    // Caught up: next the month before what's been read.
    const mined = [{ from: '2026-08-15', to: '2026-11-15' }, { from: '2026-11-16', to: '2026-11-18' }];
    j = planAuto({ mined, today, historyDays: 365, recentDone: null });
    assert.deepEqual([j.kind, j.from, j.to], ['history', '2026-07-15', '2026-08-14']);
    // History target reached: the daily two-week refresh, once.
    const all = [{ from: '2025-11-19', to: '2026-11-18' }];
    j = planAuto({ mined: all, today, historyDays: 365, recentDone: '2026-11-18' });
    assert.deepEqual([j.kind, j.from, j.to, j.refreshFrom], ['recent', '2026-11-05', '2026-11-18', '2026-07-12']);
    assert.equal(planAuto({ mined: all, today, historyDays: 365, recentDone: today }), null);
    // The last chunk stops at the history target.
    j = planAuto({ mined: [{ from: '2025-12-01', to: '2026-11-18' }], today, historyDays: 365, recentDone: today });
    assert.deepEqual([j.from, j.to], ['2025-11-19', '2025-11-30']);
  });

  test('runs by itself until history is read, survives a restart, and never re-sends a classified case to Claude', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    let calls = 0;
    const classifier = async () => {
      calls++;
      return { is_complaint: true, category: 'quality_missed', tone: 'frustrated', severity: 2, areas: [], hard_route: null, summary: 'x', confidence: 0.9 };
    };
    const { createSyncBearer } = await import('../src/inbox/lookup.js');
    const make = () => createComplaints({ db, config, reports, fetchImpl, classifier, syncBearer: createSyncBearer({ config, fetchImpl }), log: quiet });
    let complaints = make();
    await complaints.saveSettings({ auto: { enabled: true, history_months: 3 } });
    const drain = async (c) => {
      for (let i = 0; i < 400; i++) {
        const st = await c.status();
        if (!st.running && !st.auto.next) return st;
        if (!st.running) await c.maybeRun();
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('automatic updates never finished');
    };
    assert.equal(await complaints.maybeRun(), true, 'starts without anyone clicking');
    // "Restart" part-way: a run left running is marked interrupted and its dates are read again.
    await db.query("INSERT INTO complaint_runs (window_from, window_to, status, log) VALUES ('2026-01-01', '2026-01-31', 'running', '[]')");
    complaints = make();
    await complaints.markInterrupted();
    const st = await drain(complaints);
    assert.equal(st.auto.next, null);
    assert.ok(st.auto.last_daily_update, 'the daily update ran after the history was read');
    assert.ok(st.mined.length >= 3, 'history read in monthly pieces');
    const cases = Number((await db.query('SELECT count(*)::int AS n FROM complaint_cases')).rows[0].n);
    assert.ok(cases > 0);
    assert.ok(calls <= cases, `each case classified once (${calls} Claude calls for ${cases} cases)`);
    // Turned off in settings: nothing more is planned.
    await complaints.saveSettings({ auto: { enabled: false } });
    assert.equal(await complaints.maybeRun(), false);
    await db.close();
  });
});

describe('complaints: checking the taxonomy by hand', () => {
  test('accuracy is measured against what the engine said, and thin samples are flagged', () => {
    const rows = [
      ...Array.from({ length: 18 }, () => ({ verdict: 'correct', was_category: 'quality_missed', was_classified_by: 'claude', source: 'kustomer' })),
      { verdict: 'wrong_category', was_category: 'quality_missed', now_category: 'quality_rushed', was_classified_by: 'claude', source: 'kustomer' },
      { verdict: 'not_complaint', was_category: 'quality_missed', was_classified_by: 'rules', source: 'gmail' },
      { verdict: 'not_complaint', was_category: 'other', was_classified_by: 'rules', source: 'gmail' },
    ];
    const s = buildReviewStats(rows, [{ category: 'quality_missed', n: 40 }, { category: 'punctuality', n: 7 }]);
    assert.equal(s.total.checked, 21);
    const missed = s.by_category.find((c) => c.key === 'quality_missed');
    assert.equal(missed.accuracy, 0.9);
    assert.equal(missed.enough, true);
    assert.equal(missed.waiting, 40);
    assert.equal(s.by_category.find((c) => c.key === 'other').enough, false, 'one check is not a result');
    assert.equal(s.by_category.find((c) => c.key === 'punctuality').checked, 0, 'unchecked categories still listed');
    assert.equal(s.by_source.find((c) => c.key === 'gmail').not_complaint, 2);
    assert.deepEqual(s.confusions, [{ from: 'quality_missed', to: 'quality_rushed', n: 1 }]);
    assert.equal(s.waiting, 47);
  });

  test('a batch, the three verdicts, and what each does to the playbook', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    await complaints.run({ from, to });
    const before = (await complaints.listCases({ from, to })).length;
    const queue = await complaints.reviewQueue({ per: 2 });
    assert.ok(queue.length >= 3, 'needs three cases to check');
    const perCat = {};
    for (const c of queue) perCat[c.category] = (perCat[c.category] || 0) + 1;
    assert.ok(Object.values(perCat).every((n) => n <= 2), 'at most the asked number per category');
    assert.ok(queue.every((c) => !('raw' in c) && !('source_id' in c)));
    assert.ok(queue.every((c) => c.text), 'the rating comment is shown to the reviewer');
    const [a, b, c] = queue;
    const other = a.category === 'punctuality' ? 'communication' : 'punctuality';
    await complaints.reviewCase(a.id, { verdict: 'correct' }, null);
    await complaints.reviewCase(b.id, { verdict: 'wrong_category', category: other === b.category ? 'scope_booking' : other }, null);
    await complaints.reviewCase(c.id, { verdict: 'not_complaint' }, null);
    const stats = await complaints.reviewStats();
    assert.equal(stats.total.checked, 3);
    assert.equal(stats.total.correct, 1);
    assert.equal(stats.total.not_complaint, 1);
    assert.equal(stats.by_category.find((g) => g.key === b.category).wrong_category >= 1, true, 'counted against the category the engine chose');
    assert.equal((await complaints.getCase(b.id)).classified_by, 'human');
    assert.equal((await complaints.listCases({ from, to })).length, before - 1, 'not-a-complaint leaves the case list');
    assert.equal((await complaints.playbook({ from, to })).totals.cases, before - 1);
    const again = await complaints.reviewQueue({ per: 100 });
    assert.ok(![a.id, b.id, c.id].some((id) => again.some((x) => x.id === id)), 'checked cases are not shown again');
    // A later run must not bring the excluded case back or undo the person's category.
    await complaints.run({ from, to });
    assert.equal((await complaints.listCases({ from, to })).length, before - 1);
    assert.equal((await complaints.getCase(b.id)).classified_by, 'human');
    await assert.rejects(complaints.reviewCase(999999, { verdict: 'correct' }, null), /Not found/);
    await db.close();
  });
});

describe('complaints: every playbook number is traceable', () => {
  const mk = () => {
    const cases = [];
    const resolutions = [];
    const costs = [];
    const outcomes = [];
    let id = 1;
    const add = (category, { rung, action, cost = 0, outcome, opened = '2026-06-10T12:00:00Z', matched = true, one_time = false, o120 }) => {
      const c = { id: id++, source: 'kustomer', opened_at: opened, category, l27_customer_id: matched ? 500 + id : null, classified_by: 'claude', one_time };
      cases.push(c);
      if (rung) resolutions.push({ case_id: c.id, rung, action });
      if (cost) costs.push({ case_id: c.id, kind: 'refund', amount: cost, estimated: false });
      if (outcome) outcomes.push({ case_id: c.id, day: 60, outcome });
      if (o120) outcomes.push({ case_id: c.id, day: 90, outcome: o120 }, { case_id: c.id, day: 120, outcome: o120 });
      return c;
    };
    return { cases, resolutions, costs, outcomes, add, build: () => buildPlaybook({ cases, resolutions, costs, outcomes, visits: [], from: '2026-05-01', to: '2026-11-15', settings: normalizeSettings({}), today: '2026-11-16' }) };
  };

  test('rates show their numerator and denominator, and the rest is explained', () => {
    const m = mk();
    for (let i = 0; i < 5; i++) m.add('punctuality', { outcome: i < 2 ? 'saved' : i < 3 ? 'partial_save' : 'lost', cost: 100 });
    m.add('punctuality', { outcome: 'pending', opened: '2026-11-01T12:00:00Z' }); // too recent
    m.add('punctuality', { matched: false, cost: 40 }); // no Launch27 client
    m.add('punctuality', { one_time: true, o120: 'rebooked' });
    m.add('punctuality', { one_time: true, o120: 'not_rebooked' });
    m.add('punctuality', { outcome: 'pending' }); // old enough, still nothing recorded
    const t = m.build().taxonomy.find((x) => x.key === 'punctuality');
    assert.equal(t.n, 10);
    assert.equal(t.ids.length, 10);
    assert.equal(t.decided, 5);
    assert.deepEqual([t.saved_n, t.partial_n, t.lost_n], [2, 1, 2]);
    assert.equal(t.saved_n + t.partial_n + t.lost_n, t.decided, 'the three verdicts add up to decided');
    assert.equal(t.saved, 0.4);
    assert.equal(t.excluded_n, 5);
    assert.deepEqual(Object.fromEntries(Object.entries(t.excluded).map(([k, v]) => [k, v.length])), { too_recent: 1, unmatched: 1, one_time: 2, no_outcome: 1 });
    assert.equal(t.decided + t.excluded_n, t.n, 'decided plus not counted is every case');
    assert.equal(t.avg_cost, 54, 'average over all 10 cases');
    assert.equal(t.avg_cost_decided, 100, 'average over the same 5 cases the rates use');
    assert.equal(t.total_cost, 540);
    assert.equal(t.total_n, 10);
    assert.deepEqual([t.one_time.n, t.one_time.decided, t.one_time.rebooked_120_n, t.one_time.rebooked_120], [2, 2, 1, 0.5]);
  });

  test('"cheapest that works" always answers, with a grade and a reason', () => {
    const m = mk();
    m.add('communication', { rung: 'L3', action: 'reclean_full', outcome: 'saved' });
    m.add('communication', { rung: 'L3', action: 'reclean_full', outcome: 'saved' });
    m.add('communication', { rung: 'L3', action: 'reclean_full', outcome: 'lost' });
    m.add('communication', { rung: 'L3', action: 'reclean_full', outcome: 'lost' });
    m.add('scope_booking', { outcome: 'pending', opened: '2026-11-05T12:00:00Z' });
    m.add('damage', { rung: 'L1', action: 'credit', outcome: 'saved' });
    const pb = m.build();
    const by = (k) => pb.taxonomy.find((x) => x.key === k).cheapest_that_works;
    assert.deepEqual([by('communication').name, by('communication').grade, by('communication').reason], ['Reclean', 'Low', '4 cases with a known outcome, 2 saved']);
    assert.equal(by('communication').basis, 'compared');
    assert.equal(by('damage').basis, 'few');
    assert.equal(by('damage').reason, '1 case with a known outcome, 1 saved');
    assert.equal(by('scope_booking').basis, 'no_outcomes');
    assert.match(by('scope_booking').reason, /no outcomes yet/);
    assert.ok(pb.taxonomy.every((x) => x.cheapest_that_works && x.cheapest_that_works.grade));
  });

  test('ladder, months and totals carry the case ids behind them', () => {
    const m = mk();
    const a = m.add('quality_missed', { rung: 'L5', action: 'refund', cost: 60, outcome: 'saved' });
    const b = m.add('damage', { outcome: 'lost' });
    b.hard_route = 'damage_over_100';
    const pb = m.build();
    assert.deepEqual(pb.ladder.find((r) => r.rung === 'L5').ids, [a.id]);
    assert.deepEqual(pb.totals.hard_routed_ids, [b.id]);
    assert.deepEqual(pb.hard_routes.find((h) => h.key === 'damage_over_100').ids, [b.id]);
    assert.ok(pb.ladder.every((r) => !r.ids.includes(b.id)), 'escalated cases are not on the ladder');
    assert.deepEqual(pb.totals.ids.sort(), [a.id, b.id]);
    assert.ok(pb.excluded_labels.too_recent);
  });
});

describe('complaints: root causes (why it happened)', () => {
  test('the codebook rules: the specific "why" wins over the symptom', () => {
    const r = classifyRules('Since our cleaner left it has not been the same. The bathroom was missed and there was dust everywhere.');
    assert.equal(r.category, 'quality_missed', 'the category is still what they complained about');
    assert.equal(r.cause, 'regular_left');
    assert.ok(r.contributing.includes('missed_areas'));
    assert.equal(r.cause_by, 'rules');
    assert.equal(causeRules('A different person showed up and nobody told us.').cause, 'changed_unannounced');
    assert.equal(causeRules('Every time it is someone new, we never get the same person.').cause, 'no_regular');
    assert.equal(causeRules('Please stop sending me so many emails.').cause, 'marketing_emails');
    assert.equal(causeRules('Only one cleaner came, we booked two.').cause, 'team_size');
    assert.equal(causeRules("She didn't understand my instructions at all.").cause, 'language');
    assert.equal(causeRules('I asked them not to use bleach on the counters and they did anyway.').cause, 'instructions_ignored');
    assert.equal(causeRules('Great job, thank you!').cause, null);
    for (const c of CAUSES) {
      assert.ok(c.definition && c.not_when && c.examples.length === 2, `${c.key} has a full codebook entry`);
      assert.ok(CAUSE_GROUPS.some((g) => g.key === c.group), `${c.key} is in a group`);
    }
  });

  test("Claude's cause wins; its 'none of these' keeps a cause the rules found, and always counts as read", () => {
    const rules = classifyRules('The new cleaner missed the kitchen.');
    const viaClaude = mergeClassification(rules, { category: 'quality_missed', tone: 'mild', severity: 2, areas: [], cause: 'replacement_quality', contributing: ['missed_areas', 'replacement_quality', 'bogus'], cause_evidence: 'not as good as our old cleaner' });
    assert.equal(viaClaude.cause, 'replacement_quality');
    assert.deepEqual(viaClaude.contributing, ['missed_areas'], 'no repeats of the cause, no unknown keys');
    assert.equal(viaClaude.cause_by, 'claude');
    const otherWithRules = mergeClassification(rules, { category: 'quality_missed', tone: 'mild', severity: 2, areas: [], cause: 'other', contributing: [] });
    assert.equal(otherWithRules.cause, rules.cause);
    assert.equal(otherWithRules.cause_by, 'rules');
    const otherAlone = mergeClassification(classifyRules('Not happy.'), { category: 'other', tone: 'mild', severity: 1, areas: [] });
    assert.equal(otherAlone.cause, 'other');
    assert.equal(otherAlone.cause_by, 'claude', 'read once, never re-sent just for a cause');
  });

  test("Launch27 facts: the regular cleaner who stopped working, and what they point at", () => {
    const DAY = 86_400_000;
    const at = Date.parse('2026-06-01T15:00:00Z');
    const v = (d, id) => ({ id: 3000 + d, at: at + d * DAY, date: '', revenue: 150, freq: 'Weekly', teams: [{ id, name: `Cleaner ${id}` }] });
    const client = [v(-56, 5), v(-49, 5), v(-42, 5), v(-35, 5), v(-7, 8)];
    const everyone = [...client, v(-20, 8), v(30, 8)];
    const j = journeyAt(client, at, { cleanerLastWorked: cleanerLastWorkedIndex(everyone, at + 60 * DAY), dataTo: at + 60 * DAY });
    assert.equal(j.regular_cleaner_name, 'Cleaner 5');
    assert.equal(j.regular_cleaner_left, true);
    assert.equal(j.regular_cleaner_last_worked, new Date(at - 35 * DAY).toISOString().slice(0, 10));
    const stillHere = journeyAt(client, at, { cleanerLastWorked: cleanerLastWorkedIndex([...everyone, v(10, 5)], at + 60 * DAY), dataTo: at + 60 * DAY });
    assert.equal(stillHere.regular_cleaner_left, false, 'still working with other clients');
    const tooSoon = journeyAt(client, at, { cleanerLastWorked: cleanerLastWorkedIndex(everyone, at), dataTo: at - 20 * DAY });
    assert.equal(tooSoon.regular_cleaner_left, false, 'a short gap at the end of the data is not leaving');
    assert.equal(regularCleaner([v(-7, 8)]), null, 'one visit is nobody\'s regular');
    const facts = causeFacts({ ...j, cleaner_changed_last_visit: true, distinct_cleaners_90d: 2, cleaner_visits_before: 4 });
    assert.deepEqual(facts.map((f) => f.cause), ['regular_left', 'changed_unannounced', 'new_cleaner']);
    assert.match(facts[0].text, /Cleaner 5/);
  });

  test('the playbook by cause: one row per cause, contributing counted beside it, categories inside', () => {
    const cases = [];
    const outcomes = [];
    const add = (category, cause, contributing = [], outcome = 'saved') => {
      const id = cases.length + 1;
      cases.push({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category, cause, contributing_causes: contributing, cause_by: cause ? 'claude' : null, l27_customer_id: 900 + id, classified_by: 'claude' });
      outcomes.push({ case_id: id, day: 60, outcome });
    };
    add('quality_missed', 'regular_left', ['missed_areas'], 'lost');
    add('cleaner_change', 'regular_left', [], 'lost');
    add('quality_missed', 'missed_areas');
    add('communication', 'marketing_emails');
    add('punctuality', null);
    const pb = buildPlaybook({ cases, resolutions: [], costs: [], outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-27' });
    const left = pb.by_cause.find((x) => x.key === 'regular_left');
    assert.equal(left.n, 2);
    assert.deepEqual(left.ids, [1, 2]);
    assert.equal(left.lost_n, 2);
    assert.deepEqual(left.by_category.map((c) => c.key).sort(), ['cleaner_change', 'quality_missed']);
    assert.equal(left.group, 'consistency');
    const missed = pb.by_cause.find((x) => x.key === 'missed_areas');
    assert.equal(missed.n, 1);
    assert.deepEqual(missed.contributing_ids, [1]);
    assert.equal(pb.by_cause.at(-1).key, 'unset', 'cases with no cause yet come last');
    assert.equal(pb.cause_groups.find((g) => g.key === 'consistency').n, 2);
    assert.equal(pb.cause_groups.find((g) => g.key === 'communication').n, 1);
    assert.ok(pb.taxonomy.find((t) => t.key === 'quality_missed').cheapest_that_works, 'the category table is unchanged');
  });

  test('cause accuracy is measured separately, by cause and by who set it', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => ({ verdict: 'correct', was_category: 'quality_missed', was_cause: 'regular_left', was_cause_by: 'claude', now_cause: 'regular_left', cause_verdict: 'correct', source: 'kustomer' })),
      { verdict: 'correct', was_category: 'quality_missed', was_cause: 'missed_areas', was_cause_by: 'rules', now_cause: 'replacement_quality', cause_verdict: 'wrong', source: 'kustomer' },
      { verdict: 'correct', was_category: 'quality_missed', source: 'gmail' },
    ];
    const s = buildReviewStats(rows);
    assert.equal(s.cause.total.checked, 4, 'checks that skipped the cause are not counted');
    assert.equal(s.cause.total.accuracy, 0.75);
    assert.equal(s.cause.by_cause.find((c) => c.key === 'regular_left').accuracy, 1);
    assert.equal(s.cause.by_setter.find((c) => c.key === 'rules').wrong, 1);
    assert.deepEqual(s.cause.confusions, [{ from: 'missed_areas', to: 'replacement_quality', n: 1 }]);
  });

  test('checking a cause fixes the case, is measured against the engine, and survives a later run', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    await complaints.run({ from, to });
    const queue = await complaints.reviewQueue({ per: 5 });
    assert.ok(queue.length >= 2);
    assert.ok(queue.every((c) => Array.isArray(c.facts)), 'Launch27 facts come with every case to check');
    const [a, b] = queue;
    await complaints.reviewCase(a.id, { verdict: 'correct', cause: a.cause || 'other' }, null);
    const pick = b.cause === 'language' ? 'team_size' : 'language';
    await complaints.reviewCase(b.id, { verdict: 'correct', cause: pick, contributing: ['marketing_emails', pick, 'marketing_emails'] }, null);
    const stats = await complaints.reviewStats();
    assert.equal(stats.cause.total.checked, 2);
    assert.equal(stats.cause.total.correct, 1);
    const fixed = await complaints.getCase(b.id);
    assert.equal(fixed.cause, pick);
    assert.equal(fixed.cause_by, 'human');
    assert.deepEqual(fixed.contributing_causes, ['marketing_emails']);
    assert.ok((await complaints.listCases({ from, to, cause: pick })).some((c) => c.id === b.id), 'the case list filters by cause');
    await complaints.run({ from, to });
    assert.equal((await complaints.getCase(b.id)).cause, pick, "a later run doesn't undo a person's cause");
    const pb = await complaints.playbook({ from, to });
    assert.ok(pb.by_cause.find((x) => x.key === pick).ids.includes(b.id));
    await db.close();
  });
});
