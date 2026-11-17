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
import { mapStatus, toCase, discover, createKustomerClient, findListing } from '../src/complaints/sources/kustomer.js';
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
