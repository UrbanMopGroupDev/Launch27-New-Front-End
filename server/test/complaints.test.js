// Complaint Resolution Engine, Phase 1. This repo is public: every name below is made up,
// written in the same formats as the real finance-channel posts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRefundPost, reasonKind } from '../src/complaints/slackRefunds.js';
import { classifyRules, mergeClassification, hardRouteFor } from '../src/complaints/taxonomy.js';
import { redact } from '../src/complaints/redact.js';
import { outcomeAt, journeyAt, recleanCost } from '../src/complaints/journey.js';
import { normalizeSettings, canApprove, rungForRefund, budgetStatus, DEFAULT_SETTINGS } from '../src/complaints/settings.js';
import { buildPlaybook } from '../src/complaints/playbook.js';
import { mapStatus, toCase, discover } from '../src/complaints/sources/kustomer.js';
import { createComplaints } from '../src/complaints/service.js';
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
