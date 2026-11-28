// Complaints tracker and the Cleaner Adjustment form (docs/complaint-tracker.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { loadConfig } from '../src/config.js';
import { cleanerIndex, cleanerTitle, createTracker, fromKustomer, torontoDay } from '../src/tracker/service.js';
import { FIELDS, VIEWS, cleanValue } from '../src/tracker/fields.js';
import { ADJUSTMENT_CATEGORIES, cleanAdjustment, createAdjustments, sheetCells, sheetSerial } from '../src/tracker/adjustments.js';
import { parseAdjustmentRows } from '../src/reports/adjustments.js';

const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {} });
const NOW = Date.parse('2026-11-26T15:00:00Z');
const user = { id: 1, name: 'Ana Agent', email: 'ana@example.com' };

async function freshDb() {
  const db = await openDb();
  await db.query("INSERT INTO users (email, name, role) VALUES ('ana@example.com', 'Ana Agent', 'admin'), ('jose@example.com', 'Jose Manager', 'supervisor')");
  return db;
}

// A Kustomer complaint as its API returns one (shape read from the live account).
const kobject = (id, custom, attrs = {}, rel = {}) => ({
  type: 'kobject.complaint',
  id,
  attributes: { title: `Complaint ${id}`, status: 'open', createdAt: '2026-11-20T15:00:00.000Z', updatedAt: '2026-11-21T15:00:00.000Z', custom, ...attrs },
  relationships: { customer: { data: { type: 'customer', id: 'kc1' } }, ...rel },
});

function fakeKustomer(objects, comments = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v1/klasses') return ok({ data: [{ id: 'k1', attributes: { name: 'complaint', displayName: 'Complaint' } }] });
    if (u.pathname === '/v1/klasses/complaint') return ok({ data: objects, links: { next: null } });
    const m = u.pathname.match(/^\/v1\/kobjects\/([^/]+)\/comments$/);
    if (m) return ok({ data: comments[m[1]] || [] });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

describe('Complaints tracker', () => {
  test('a Kustomer complaint maps field for field, with dates as Toronto days', () => {
    assert.equal(torontoDay('2026-03-12T04:00:00.000Z'), '2026-03-12');
    assert.equal(torontoDay('2026-11-26T04:59:00.000Z'), '2026-11-25', 'before midnight in Toronto is still the day before');
    const rec = fromKustomer(kobject('a1', { statusStr: 'Awaiting client response', originalServiceDateAt: '2026-11-18T05:00:00.000Z', ltvOfClientStr: '1,840', osNameStr: ' Jetrin Samson ', complaintNotesTxt: 'Stove hood missed.', inputIntoUmPortalStr: null, tierLevelStr: 'Tier 1', atRiskMiaAmtNotAppliedYetNum: 44 }, { status: 'snoozed', snooze: { time: '2026-11-27T23:00:00.000Z' }, commentCount: 2 }, { conversation: { data: { id: 'conv9' } } }));
    assert.equal(rec.state, 'snoozed');
    assert.equal(rec.snooze_until, '2026-11-27T23:00:00.000Z');
    assert.deepEqual([rec.fields.status, rec.fields.original_service_date, rec.fields.ltv_of_client, rec.fields.case_opened_by, rec.fields.input_into_um_portal, rec.fields.at_risk_mia_amount], ['Awaiting client response', '2026-11-18', 1840, 'Jetrin Samson', null, 44]);
    assert.deepEqual([rec.source_meta.customer, rec.source_meta.conversation, rec.source_meta.comment_count], ['kc1', 'conv9', 2]);
    assert.equal(new Set(FIELDS.map((f) => f.k)).size, FIELDS.length, 'each field loads from its own Kustomer field');
  });

  test('picklists only take their own options', () => {
    const status = FIELDS.find((f) => f.key === 'status');
    assert.equal(cleanValue(status, 'For Review'), 'For Review');
    assert.throws(() => cleanValue(status, 'Sort of open'), /pick one/);
    assert.equal(cleanValue(FIELDS.find((f) => f.key === 'ltv_of_client'), '$1,200'), 1200);
    assert.throws(() => cleanValue(FIELDS.find((f) => f.key === 'due_date'), 'tomorrow'), /date/);
    assert.equal(cleanValue(status, ''), null);
  });

  test("Kustomer's searches: each view shows what its filter says, with live counts", async () => {
    const db = await freshDb();
    try {
      const t = createTracker({ db, config: { l27Mode: 'mock', ratingLinkDays: 7 }, log: quiet, now: () => NOW });
      const mk = (body) => t.create(user, body).then((r) => r.record);
      const review = await mk({ title: 'Missed Areas : Shakar and Mariam', original_service_date: '2026-11-24' });
      await mk({ title: 'Older, rating link nearly gone', status: 'Awaiting client response', original_service_date: '2026-11-20' });
      await mk({ title: 'Entered already', status: 'Reclean scheduled', original_service_date: '2026-11-10', input_into_um_portal: 'Yes', mia_categories: 'Damages and reimbursements' });
      await mk({ title: 'Closed, no assessment', status: 'Closed', original_service_date: '2026-11-01', input_into_um_portal: 'No' });
      await mk({ title: 'Closed and assessed', status: 'Closed', manager_impact_assessment: '44', input_into_um_portal: 'Yes' });
      assert.equal(review.status, 'For Review', 'a new complaint starts For Review');
      assert.equal(review.case_opened_by, 'Ana Agent');
      assert.equal(review.complaint_created_on, '2026-11-26');

      const counts = await t.counts();
      assert.deepEqual(
        Object.fromEntries(['for-review', 'awaiting-client-response', 'reclean-scheduled', 'monetary-impact-assessment', 'all-closed', 'overview', 'um-portal-required', 'no-mia-categories', 'um-portal-positive'].map((k) => [k, counts[k]])),
        { 'for-review': 1, 'awaiting-client-response': 1, 'reclean-scheduled': 1, 'monetary-impact-assessment': 1, 'all-closed': 1, overview: 4, 'um-portal-required': 2, 'no-mia-categories': 4, 'um-portal-positive': 0 },
      );
      for (const v of VIEWS.filter((x) => x.where)) assert.equal((await t.list({ view: v.slug })).rows.length, counts[v.slug], v.name);

      // Input to UM Portal Required: fewest days left on the Launch27 rating link first.
      const portal = await t.list({ view: 'um-portal-required' });
      assert.deepEqual(portal.rows.map((r) => [r.title, r.rating_days_left]), [['Older, rating link nearly gone', 1], ['Missed Areas : Shakar and Mariam', 5]]);
      assert.equal(portal.sort, 'rating_days_left');

      // Sortable columns, and an unknown one falls back rather than reaching the SQL.
      const byName = await t.list({ view: 'overview', sort: 'original_service_date', dir: 'asc' });
      assert.deepEqual(byName.rows.map((r) => r.original_service_date), ['2026-11-01', '2026-11-10', '2026-11-20', '2026-11-24']);
      assert.equal((await t.list({ view: 'overview', sort: 'id; DROP TABLE users' })).sort, 'created_at');
      await assert.rejects(t.list({ view: 'nope' }), /Unknown view/);
      assert.equal((await t.list({ view: 'overview', q: 'shakar' })).rows.length, 1);
    } finally {
      await db.close();
    }
  });

  test('a complaint: edit, assign to me, snooze, mark done, close, bulk, comments with @mentions', async () => {
    const db = await freshDb();
    try {
      let clock = NOW;
      const t = createTracker({ db, config: { l27Mode: 'mock' }, log: quiet, now: () => clock });
      const { record } = await t.create(user, { title: 'Broken lamp' });
      const id = Number(record.id);

      let got = (await t.patch(user, id, { assigned_user_id: 'me', tier_level: 'Tier 2', received_photos: 'Yes', manager_impact_assessment: '60' })).record;
      assert.deepEqual([got.assigned_user, got.tier_level, got.received_photos, got.manager_impact_assessment], ['Ana Agent', 'Tier 2', 'Yes', '60']);
      await assert.rejects(t.patch(user, id, { tier_level: 'Tier 9' }), /Tier Level/);
      await assert.rejects(t.patch(user, id, { title: '  ' }), /title/);
      await assert.rejects(t.patch(user, 999, { title: 'x' }), /not found/);

      await assert.rejects(t.patch(user, id, { state: 'snoozed', snooze_until: '2026-11-01T00:00:00Z' }), /future/);
      got = (await t.patch(user, id, { state: 'snoozed', snooze_until: '2099-01-01T14:00:00Z' })).record; // far future: the wake-up check reads the database's real clock
      assert.equal(got.state, 'snoozed');
      await db.query("UPDATE complaint_records SET snooze_until = now() - interval '1 minute' WHERE id = $1", [id]);
      assert.equal((await t.get(id)).record.state, 'open', 'a snoozed complaint comes back when its time is up');

      // Closing needs the outcome and the cost; the MIA category only when it cost something.
      await assert.rejects(t.patch(user, id, { status: 'Closed' }), /Final Resolution Category; MIA Categories/, 'it already has an MIA of 60');
      await t.patch(user, id, { final_resolution_category: 'Reclean', manager_impact_assessment: '$60' });
      await assert.rejects(t.patch(user, id, { status: 'Closed' }), /MIA Categories/);
      await t.patch(user, id, { manager_impact_assessment: '0' });
      got = (await t.patch(user, id, { status: 'Closed', state: 'done' })).record;
      assert.deepEqual([got.state, got.status, got.closed_date], ['done', 'Closed', '2026-11-26']);
      await assert.rejects(t.patch(user, id, { manager_impact_assessment: 'lots' }), /closed complaint needs: Manager Impact Assessment as a dollar amount/);
      await assert.rejects(t.patch(user, id, { final_resolution_category: null }), /Final Resolution Category/);
      await t.patch(user, id, { manager_impact_assessment: '44', mia_categories: 'Damages and reimbursements' });

      // Assigning someone else tells them.
      const jose = Number((await db.query("SELECT id FROM users WHERE email = 'jose@example.com'")).rows[0].id);
      await t.patch(user, id, { assigned_user_id: jose });
      const second = Number((await t.create(user, { title: 'Second' })).record.id);
      assert.deepEqual(await t.bulk(user, [id, second, second], { state: 'open', assigned_user_id: 'me' }), { updated: 2 });
      assert.equal((await t.get(second)).record.assigned_user, 'Ana Agent');
      await assert.rejects(t.bulk(user, [], { state: 'done' }), /Tick/);
      await assert.rejects(t.bulk(user, [id], {}), /Nothing/);

      const c = await t.comment(user, id, 'Checked with @jose, he approves the refund. cc @ana');
      assert.equal(c.author, 'Ana Agent');
      await assert.rejects(t.comment(user, id, '   '), /Write a comment/);
      const notes = (await db.query('SELECT user_id, kind, complaint_record_id, conversation_id, text FROM notifications ORDER BY id')).rows;
      assert.deepEqual(notes.map((n) => [Number(n.user_id), n.kind, Number(n.complaint_record_id), n.conversation_id]), [[jose, 'assigned', id, null], [jose, 'mention', id, null]], 'the assignee and the person mentioned are told; you are not told about yourself');
      const full = await t.get(id);
      assert.equal(full.comments.length, 1);
      assert.equal(full.record.comment_count, 1);
      clock += 1;
    } finally {
      await db.close();
    }
  });

  test('from a conversation: the button makes the complaint once, then opens the same one', async () => {
    const db = await freshDb();
    try {
      const contact = (await db.query("INSERT INTO contacts (name, roles, l27_customer_id) VALUES ('Michel Bouthillier', '[\"customer\"]', 4411) RETURNING id")).rows[0];
      const conv = (await db.query("INSERT INTO conversations (contact_id, channel, subject, l27_booking_id, cleaner_name) VALUES ($1, 'email', 'Not happy with the clean', 9001, 'Mariam Adi') RETURNING id", [contact.id])).rows[0];
      const t = createTracker({ db, config: { l27Mode: 'mock' }, log: quiet, now: () => NOW });
      const first = await t.create(user, { conversation_id: Number(conv.id) });
      assert.equal(first.existing, false);
      assert.deepEqual([first.record.customer_name, first.record.cleaner_name, Number(first.record.contact_id), Number(first.record.l27_customer_id), Number(first.record.l27_booking_id), first.record.title], ['Michel Bouthillier', 'Mariam Adi', Number(contact.id), 4411, 9001, 'Complaint for Michel Bouthillier']);
      assert.equal(first.record.conversation_subject, 'Not happy with the clean');
      const again = await t.create(user, { conversation_id: Number(conv.id) });
      assert.equal(again.existing, true);
      assert.equal(Number(again.record.id), Number(first.record.id));
      assert.equal((await t.forConversation(Number(conv.id))).length, 1);
      assert.equal((await t.forContact(Number(contact.id))).length, 1);
      // Once that one is done, a new problem on the same conversation is a new complaint.
      await t.patch(user, Number(first.record.id), { state: 'done' });
      assert.equal((await t.create(user, { conversation_id: Number(conv.id) })).existing, false);
      await assert.rejects(t.create(user, { conversation_id: 99999 }), /not found/);

      // Positive feedback waiting to be entered in Launch27.
      assert.equal((await t.positiveSet(user, Number(conv.id), 'flag')).done_at, null);
      assert.deepEqual((await t.positiveList()).map((p) => [Number(p.conversation_id), p.contact_name, p.flagged_by]), [[Number(conv.id), 'Michel Bouthillier', 'Ana Agent']]);
      assert.equal((await t.counts())['um-portal-positive'], 1);
      await t.positiveSet(user, Number(conv.id), 'done');
      assert.equal((await t.positiveList()).length, 0);
      await assert.rejects(t.positiveSet(user, Number(conv.id), 'explode'), /Unknown action/);
    } finally {
      await db.close();
    }
  });

  test('loading from Kustomer: the last 30 days plus anything still open, GET only, never over an edit', async () => {
    const db = await freshDb();
    try {
      const contact = (await db.query("INSERT INTO contacts (name, roles, l27_customer_id) VALUES ('Lynn Curry', '[\"customer\"]', 77) RETURNING id")).rows[0];
      const conv = (await db.query("INSERT INTO conversations (contact_id, channel, status, source, source_id) VALUES ($1, 'email', 'done', 'kustomer', 'conv9') RETURNING id", [contact.id])).rows[0];
      const objects = [
        kobject('recent-closed', { statusStr: 'Closed', customerNameStr: 'Lynn Curry', managerImpactAssessmentStr: '44' }, { status: 'done', commentCount: 2 }, { conversation: { data: { id: 'conv9' } } }),
        kobject('old-open', { statusStr: 'Awaiting client response', originalServiceDateAt: '2026-08-02T04:00:00.000Z' }, { createdAt: '2026-08-03T15:00:00.000Z' }),
        kobject('old-closed', { statusStr: 'Closed' }, { createdAt: '2026-08-03T15:00:00.000Z', status: 'done' }),
      ];
      const comments = { 'recent-closed': [{ id: 'c1', attributes: { body: 'Offered a bi\\-weekly discount', createdAt: '2026-11-21T10:00:00.000Z' } }, { id: 'c2', attributes: { body: '  ' } }] };
      const k = fakeKustomer(objects, comments);
      const t = createTracker({ db, config: { kustomerApiKey: 'key', l27Mode: 'live' }, fetchImpl: k.fetchImpl, log: quiet, now: () => NOW });
      t.startLoad(user);
      assert.throws(() => t.startLoad(user), /already running/);
      await t.loadDone();
      const status = t.loadStatus();
      assert.equal(status.error, null);
      assert.deepEqual(status.result, { seen: 3, loaded: 2, kept_as_edited: 0, comments: 1, linked_conversation: 1, linked_contact: 1, linked: { users: 0, cleaners: 0 } });
      assert.ok(k.calls.every((c) => c.startsWith('GET ')), 'Kustomer is only ever read');

      const rows = (await db.query("SELECT id, source_id, state, status, conversation_id, contact_id, l27_customer_id, created_at FROM complaint_records WHERE source = 'kustomer' ORDER BY source_id")).rows;
      assert.deepEqual(rows.map((r) => [r.source_id, r.state, r.status]), [['old-open', 'open', 'Awaiting client response'], ['recent-closed', 'done', 'Closed']]);
      const closed = rows[1];
      assert.deepEqual([Number(closed.conversation_id), Number(closed.contact_id), Number(closed.l27_customer_id)], [Number(conv.id), Number(contact.id), 77], 'linked to the imported conversation and its customer');
      assert.equal(new Date(closed.created_at).toISOString(), '2026-11-20T15:00:00.000Z', "keeps Kustomer's created date");
      assert.deepEqual((await t.get(Number(closed.id))).comments.map((c) => [c.author, c.body]), [['Kustomer comment', 'Offered a bi-weekly discount']]);

      // Someone works a complaint here; a second load refreshes the untouched one only.
      await t.patch(user, Number(closed.id), { final_resolution_category: 'Reclean' });
      objects[0].attributes.custom.finalResolutionCategoryStr = 'Full Refund';
      objects[1].attributes.custom.statusStr = 'For Review';
      t.startLoad(user);
      await t.loadDone();
      assert.deepEqual(t.loadStatus().result, { seen: 3, loaded: 1, kept_as_edited: 1, comments: 0, linked_conversation: 0, linked_contact: 0, linked: { users: 0, cleaners: 0 } });
      assert.equal((await t.get(Number(closed.id))).record.final_resolution_category, 'Reclean');
      assert.equal((await t.get(Number(rows[0].id))).record.status, 'For Review');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM complaint_records')).rows[0].n, 2, 'no duplicates');

      const off = createTracker({ db, config: { l27Mode: 'mock' }, log: quiet });
      assert.throws(() => off.startLoad(user), /only connected in production/);
    } finally {
      await db.close();
    }
  });

  test('names are linked to records: logins, Launch27 cleaners and contacts; who opened and closed is filled in', async () => {
    const db = await freshDb();
    try {
      const t = createTracker({ db, config: { l27Mode: 'mock' }, log: quiet, now: () => NOW });
      const jose = (await db.query("SELECT id FROM users WHERE email = 'jose@example.com'")).rows[0].id;
      const ana = Number(user.id);

      // Opened by: the login that made it.
      const made = (await t.create(user, { title: 'Missed areas' })).record;
      const id = Number(made.id);
      assert.deepEqual([made.case_opened_by, Number(made.case_opened_by_user_id)], ['Ana Agent', ana]);

      // A staff login picked for a name field: the stored name is the login's.
      let r = (await t.patch(user, id, { cs_agent_user_id: Number(jose), manager_approval_user_id: Number(jose) })).record;
      assert.deepEqual([r.cs_agent, Number(r.cs_agent_user_id), r.manager_approval], ['Jose Manager', Number(jose), 'Jose Manager']);
      await assert.rejects(t.patch(user, id, { cs_agent_user_id: 999 }), /no login/);

      // A cleaner picked by id comes with its name (the route puts in Launch27's).
      r = (await t.patch(user, id, { cleaner_id: 77, cleaner_name: 'Maria Gonzalez' })).record;
      assert.deepEqual([Number(r.cleaner_id), r.cleaner_name], [77, 'Maria Gonzalez']);
      await assert.rejects(t.patch(user, id, { cleaner_id: 77 }), /name missing/);
      // Typing a different name over it unlinks it.
      r = (await t.patch(user, id, { cleaner_name: 'Someone New' })).record;
      assert.deepEqual([r.cleaner_id, r.cleaner_name], [null, 'Someone New']);

      // A contact picked as the customer brings their name and Launch27 customer.
      const contact = (await db.query("INSERT INTO contacts (name, roles, l27_customer_id) VALUES ('Lynn Curry', '[\"customer\"]', 4412) RETURNING id")).rows[0];
      r = (await t.patch(user, id, { contact_id: Number(contact.id) })).record;
      assert.deepEqual([r.customer_name, Number(r.contact_id), Number(r.l27_customer_id)], ['Lynn Curry', Number(contact.id), 4412]);
      r = (await t.patch(user, id, { contact_id: null })).record;
      assert.deepEqual([r.contact_id, r.l27_customer_id], [null, null]);

      // Closing stamps the date and who closed it, once.
      await t.patch(user, id, { final_resolution_category: 'No Action Required', manager_impact_assessment: '0' });
      r = (await t.patch(user, id, { status: 'Closed' })).record;
      assert.deepEqual([r.closed_date, r.case_closed_by, Number(r.case_closed_by_user_id)], ['2026-11-26', 'Ana Agent', ana]);
      r = (await t.patch({ id: jose, name: 'Jose Manager' }, id, { status: 'For Review' })).record;
      r = (await t.patch({ id: jose, name: 'Jose Manager' }, id, { status: 'Closed' })).record;
      assert.equal(r.case_closed_by, 'Ana Agent', 'reclosing keeps who closed it first');

      // Names from Kustomer: matched when exactly one login or cleaner has that name.
      await db.query("INSERT INTO complaint_records (source, source_id, title, case_opened_by, cs_agent, cleaner_name) VALUES ('kustomer', 'k1', 'Loaded', ' jose manager ', 'Nobody Here', '  maria   gonzalez'), ('kustomer', 'k2', 'Loaded 2', 'ana@example.com', NULL, 'Sam Lee')");
      const teams = [{ id: 77, title: '(OTT) Maria Gonzalez' }, { id: 81, title: 'Sam Lee' }, { id: 82, title: '(BRK) Sam Lee' }];
      const linked = await t.linkNames(teams);
      const k = Object.fromEntries((await db.query("SELECT source_id, case_opened_by_user_id, cs_agent_user_id, cleaner_id, cleaner_name FROM complaint_records WHERE source = 'kustomer'")).rows.map((x) => [x.source_id, x]));
      assert.equal(Number(k.k1.case_opened_by_user_id), Number(jose));
      assert.equal(Number(k.k2.case_opened_by_user_id), ana, 'an email matches its login');
      assert.equal(k.k1.cs_agent_user_id, null, 'a name nobody has stays as typed');
      assert.deepEqual([Number(k.k1.cleaner_id), k.k1.cleaner_name], [77, 'Maria Gonzalez']);
      assert.equal(k.k2.cleaner_id, null, 'two cleaners named Sam Lee: left for a person to pick');
      assert.deepEqual(linked, { users: 2, cleaners: 1 });
      assert.deepEqual(await t.linkNames(teams), { users: 0, cleaners: 0 }, 'running it again changes nothing');
    } finally {
      await db.close();
    }
  });

  test('what has worked before: the playbook answer for the complaint type, or read from the notes', async () => {
    const db = await freshDb();
    try {
      let built = 0;
      const book = {
        taxonomy: [{
          key: 'quality_missed', n: 120, typical_name: 'Reclean', saved: 0.71, decided: 80, avg_cost: 62,
          cheapest_that_works: { rung: 'L2', name: '$10 credit', saved: 0.68, avg_cost: 10, n: 31, grade: 'High', reason: '31 cases with a known outcome, 21 saved' },
          by_rung: [{ rung: 'L2', name: '$10 credit', saved: 0.68, decided: 31, avg_cost: 10, n: 40 }, { rung: 'L3', name: 'Reclean', saved: 0.72, decided: 45, avg_cost: 85, n: 60 }, { rung: 'L5', name: 'Partial refund', saved: null, decided: 0, avg_cost: 0, n: 0 }],
          one_time: { n: 12, decided_90: 8, rebooked_90: 0.25, decided: 6, rebooked_120: 0.33, ids: [1] },
        }],
      };
      const asked = [];
      const complaints = {
        getSettings: async () => ({ pilot_months: 6 }),
        playbook: async ({ from, to }) => { built++; assert.deepEqual([from, to], ['2026-05-26', '2026-11-25']); return book; },
        rankFor: async (q) => { asked.push(q); return { groups: [], options: [{ rank: 1, response: 'reclean' }], considered: 1 }; },
      };
      const t = createTracker({ db, config: { l27Mode: 'mock' }, log: quiet, now: () => NOW, complaints });
      const typed = Number((await t.create(user, { title: 'x', complaint_type: 'Quality of Cleaning', frequency: 'One Time' })).record.id);
      const g = await t.guidance(typed);
      assert.deepEqual([g.category, g.label, g.basis, g.cases, g.typical, g.cheapest.name, g.one_time, g.one_time_stats.rebooked_90], ['quality_missed', 'Quality: missed areas', 'type', 120, 'Reclean', '$10 credit', true, 0.25]);
      assert.deepEqual(g.options.map((o) => o.name), ['$10 credit', 'Reclean'], 'responses never used are left out');
      assert.equal(g.ranked.options[0].response, 'reclean', 'the ranked options come with the guidance');
      assert.deepEqual(asked[0], { category: 'quality_missed', cause: null, one_time: true, threat: 'none', value: null });
      assert.equal(g.escalation, null);

      const fromNotes = Number((await t.create(user, { title: 'Broken vase', complaint_notes: 'The cleaner broke a vase in the hallway.' })).record.id);
      const n = await t.guidance(fromNotes);
      assert.deepEqual([n.category, n.basis, n.cases, n.cheapest], ['damage', 'notes', 0, null]);
      assert.match(n.escalation, /Office Manager/);
      assert.equal(built, 1, 'the playbook is built once and reused');

      // A likely root cause in the notes: its own history when it has enough known outcomes.
      book.by_cause = [
        { key: 'regular_left', n: 30, decided: 14, saved: 0.4, typical_name: 'Partial refund', cheapest_that_works: { rung: 'L5', name: 'Partial refund', saved: 0.5, avg_cost: 70, grade: 'Medium', reason: '14 known' }, by_rung: [] },
        { key: 'language', n: 4, decided: 3, saved: 0.3, cheapest_that_works: null, by_rung: [] },
      ];
      const left = Number((await t.create(user, { title: 'x', complaint_type: 'Quality of Cleaning', complaint_notes: 'Since our cleaner left the bathrooms are never done.' })).record.id);
      const lg = await t.guidance(left);
      assert.deepEqual([lg.category, lg.cause, lg.based_on, lg.cheapest.name, lg.cases], ['quality_missed', 'regular_left', 'cause', 'Partial refund', 30]);
      const thin = Number((await t.create(user, { title: 'x', complaint_type: 'Quality of Cleaning', complaint_notes: "She didn't understand my instructions." })).record.id);
      const tg = await t.guidance(thin);
      assert.deepEqual([tg.cause, tg.based_on, tg.cheapest.name], ['language', 'category', '$10 credit'], 'too few outcomes for the cause: the category answers');

      const angry = Number((await t.create(user, { title: 'x', complaint_type: 'Quality of Cleaning', complaint_notes: 'Bathroom missed again. I will be leaving a Google review about this.' })).record.id);
      assert.equal((await t.guidance(angry)).threat, 'review');
      assert.equal(asked.at(-1).threat, 'review', 'a review threat in the notes is passed to the ranking');
      const valued = Number((await t.create(user, { title: 'x', complaint_type: 'Quality of Cleaning', ltv_of_client: 5120 })).record.id);
      await t.guidance(valued);
      assert.equal(asked.at(-1).value, 5120, 'LTV of Client is what each option is weighed against');

      const clientFault = Number((await t.create(user, { title: 'x', complaint_type: "Complaint but Client's Fault" })).record.id);
      assert.deepEqual([(await t.guidance(clientFault)).category, (await t.guidance(clientFault)).available], [null, true]);
      assert.equal(await t.guidance(9999), null);
      const none = createTracker({ db, config: { l27Mode: 'mock' }, log: quiet });
      assert.equal((await none.guidance(typed)).available, false);

      // Bulk close: one complaint not ready stops the lot and says which.
      await assert.rejects(t.bulk(user, [typed, fromNotes], { status: 'Closed' }), new RegExp(`Complaint #${typed}: To close this complaint.*Nothing was changed`));
      assert.equal((await t.get(fromNotes)).record.status, 'For Review');
    } finally {
      await db.close();
    }
  });

  test("Launch27 cleaner names: the title without its codes; a name two cleaners share isn't used", () => {
    assert.equal(cleanerTitle({ title: '(OTT) (PT) Maria Gonzalez' }), 'Maria Gonzalez');
    assert.equal(cleanerTitle({ title: 'On Hold (OTT) Jo Park' }), 'Jo Park');
    assert.equal(cleanerTitle({ title: '', first_name: 'Ali', last_name: 'Khan' }), 'Ali Khan');
    const idx = cleanerIndex([{ id: 1, title: 'A B', first_name: 'Alpha', last_name: 'Beta' }, { id: 2, title: '(X) A B' }, { id: 3, title: 'Cee Dee' }]);
    assert.equal(idx.get('a b'), undefined);
    assert.deepEqual(idx.get('alpha beta'), { id: 1, name: 'A B' });
    assert.deepEqual(idx.get('cee dee'), { id: 3, name: 'Cee Dee' });
  });

  test('dev and QA start with a few invented complaints, once', async () => {
    const db = await freshDb();
    try {
      const t = createTracker({ db, config: { l27Mode: 'mock' }, log: quiet, now: () => NOW });
      assert.ok((await t.ensureSample()) > 5);
      assert.equal(await t.ensureSample(), 0);
      const counts = await t.counts();
      for (const v of VIEWS.filter((x) => x.where && x.slug !== 'to-schedule-a-reclean')) assert.ok(counts[v.slug] > 0, `${v.name} has a sample`);
      assert.equal(await createTracker({ db: await freshDb(), config: { l27Mode: 'live' }, log: quiet }).ensureSample(), 0, 'never in production');
    } finally {
      await db.close();
    }
  });
});

describe('Cleaner Adjustment form', () => {
  const form = { cleaner_name: ' Chelsea  Loyer ', amount: '-30', category: 'Cleaner-Initiated Last Min Cancellation', reason: 'Not feeling well', customer_name: 'Cathie Desmara', net_impact: 'Deduction', approved_by: 'Jose', customer_address: '112 Mandevilla Cres', service_date: '2026-11-20' };

  test("one submission is one row in the sheet's own layout, and the existing reader reads it back", () => {
    const f = cleanAdjustment(form, user);
    const cells = sheetCells(f);
    assert.deepEqual(cells.main, ['Chelsea Loyer', -30, 'Cleaner-Initiated Last Min Cancellation', 46346, 'Cathie Desmara', 'Deduction', 'Cleaner-Initiated Last Min Cancellation -2026-11-20T00:00:00.000Z - Not feeling well', 'Ana Agent']);
    assert.deepEqual(cells.tail, ['112 Mandevilla Cres', 'Jose']);
    assert.equal(sheetSerial('2026-11-25'), 46351, 'the number the sheet already holds for 25/11/2026');
    // As the reader sees it: the date column formatted day first, the rule column filled by the sheet's formula.
    const asRead = [cells.main[0], String(cells.main[1]), cells.main[2], '20/11/2026', cells.main[4], cells.main[5], cells.main[6], cells.main[7], 'Valid'];
    assert.deepEqual(parseAdjustmentRows([asRead]), [{ row_no: 2, cleaner_name: 'Chelsea Loyer', kind: 'late_cancel', amount: -30, on_date: '2026-11-20', customer: 'Cathie Desmara', details: cells.main[6], submitted_by: 'Ana Agent', valid: true }]);
  });

  test('the form is checked before anything is sent', () => {
    assert.throws(() => cleanAdjustment({ ...form, cleaner_name: '' }), /Cleaner Name/);
    assert.throws(() => cleanAdjustment({ ...form, amount: 'thirty' }), /number/);
    assert.throws(() => cleanAdjustment({ ...form, amount: '' }), /number/);
    assert.throws(() => cleanAdjustment({ ...form, category: 'Other' }), /Category/);
    assert.throws(() => cleanAdjustment({ ...form, net_impact: 'Bonus' }), /Net Impact/);
    assert.throws(() => cleanAdjustment({ ...form, service_date: '20/11/2026' }), /Service Date/);
    assert.throws(() => cleanAdjustment({ ...form, reason: 'x'.repeat(1025) }), /too long/);
    assert.equal(cleanAdjustment({ ...form, reason: 'x'.repeat(1024) }).reason.length, 1024);
    assert.equal(cleanAdjustment({ ...form, submitted_by: 'Grace' }, user).submitted_by, 'Grace');
    assert.equal(ADJUSTMENT_CATEGORIES.length, 12);
  });

  test('production writes to the first empty row (A to H, K and L only); dev and QA never reach Google', async () => {
    const db = await freshDb();
    try {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const serviceAccount = { client_email: 'support-inbox@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
      const sent = [];
      let refuse = false;
      const google = async (url, init = {}) => {
        const ok = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (String(url).includes('oauth2.googleapis.com')) {
          assert.match(decodeURIComponent(String(init.body)), /jwt-bearer/);
          return ok({ access_token: 'tok' });
        }
        const u = new URL(url);
        sent.push({ method: init.method, path: decodeURIComponent(u.pathname), body: init.body ? JSON.parse(init.body) : null });
        if (refuse) return ok({ error: { message: 'The caller does not have permission' } }, 403);
        if (init.method === 'GET') return ok({ values: [["Cleaner's Name"], ['Amy'], [], ['Chelsea']] });
        return ok({ totalUpdatedCells: 10 });
      };
      const paySheet = { id: 'sheet123', range: 'Sheet1!A2:I', serviceAccount };
      const prod = createAdjustments({ db, config: { appEnv: 'production', paySheet }, fetchImpl: google, log: quiet });
      assert.deepEqual(prod.meta().mode, 'live');
      assert.equal(prod.meta().sheet_url, 'https://docs.google.com/spreadsheets/d/sheet123/edit');
      assert.deepEqual(await prod.submit(user, { ...form, conversation_id: 'x' }), { outcome: 'sent', row: 5 });
      assert.deepEqual(sent.map((s) => [s.method, s.path]), [['GET', '/v4/spreadsheets/sheet123/values/Sheet1!A:A'], ['POST', '/v4/spreadsheets/sheet123/values:batchUpdate']]);
      assert.equal(sent[1].body.valueInputOption, 'RAW', 'typed text is never run as a formula');
      assert.deepEqual(sent[1].body.data.map((d) => d.range), ['Sheet1!A5:H5', 'Sheet1!K5:L5']);
      assert.equal(sent[1].body.data[0].values[0].length, 8);

      refuse = true;
      await assert.rejects(prod.submit(user, form), /as Editor/);
      const log = (await db.query('SELECT outcome, sheet_row, error, fields FROM pay_adjustment_submissions ORDER BY id')).rows;
      assert.deepEqual(log.map((l) => [l.outcome, l.sheet_row]), [['sent', 5], ['failed', null]]);
      assert.equal(log[0].fields.cleaner_name, 'Chelsea Loyer');

      // Outside production nothing is sent, even with the sheet and the account configured.
      const before = sent.length;
      const qa = createAdjustments({ db, config: { appEnv: 'staging', paySheet }, fetchImpl: google, log: quiet });
      assert.equal(qa.meta().mode, 'sandbox');
      assert.equal((await qa.submit(user, form)).outcome, 'sandbox');
      assert.equal(sent.length, before);
      const unset = createAdjustments({ db, config: { appEnv: 'production', paySheet: { id: null } }, fetchImpl: google, log: quiet });
      assert.equal(unset.meta().mode, 'not_set_up');
      await assert.rejects(unset.submit(user, form), /isn't connected/);
    } finally {
      await db.close();
    }
  });
});

describe('Tracker and adjustments over the API', () => {
  test('everyone signed in can work complaints and send an adjustment; loading from Kustomer is for admins', async () => {
    const db = await openDb();
    const mock = createMockLaunch27({ password: 'demo' });
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const server = createApp(config, { db, fetchImpl: mock, log: quiet }).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const signIn = async (email) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo' }) })).headers.get('set-cookie').split(';')[0];
      const call = async (cookie, path, method = 'GET', body) => {
        const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
      };
      assert.equal((await fetch(`${base}/api/tracker/meta`)).status, 401);
      const admin = await signIn('ana@example.com');
      const agent = await signIn('ben@example.com');
      await call(admin, '/api/me'); // first visit makes the users row, so a mention can find her

      const meta = (await call(agent, '/api/tracker/meta')).body;
      assert.equal(meta.views.length, 13);
      assert.deepEqual(meta.panels.map((p) => p.label), ['Complaint Information', 'Resolution Information', 'Approval', 'Complaint Category']);
      assert.ok(meta.fields.every((f) => !('k' in f)));
      assert.equal(meta.columns.length, 12);

      const made = await call(agent, '/api/tracker/complaints', 'POST', { title: 'Missed Areas : Shakar and Mariam', original_service_date: '2026-11-24' });
      assert.equal(made.status, 201);
      const id = made.body.record.id;
      assert.equal((await call(agent, `/api/tracker/complaints/${id}`, 'PATCH', { assigned_user_id: 'me', status: 'Awaiting client response' })).body.record.status, 'Awaiting client response');
      assert.equal((await call(agent, `/api/tracker/complaints/${id}`, 'PATCH', { status: 'Nope' })).status, 400);
      assert.equal((await call(agent, `/api/tracker/complaints/${id}/comments`, 'POST', { body: 'Looping in @ana' })).status, 201);
      assert.equal((await call(agent, '/api/tracker/complaints/bulk', 'POST', { ids: [id], patch: { state: 'done' } })).body.updated, 1);
      assert.equal((await call(agent, '/api/tracker/complaints/0')).status, 400);
      assert.equal((await call(agent, '/api/tracker/complaints/98765')).status, 404);
      assert.equal((await call(agent, '/api/tracker/counts')).body['awaiting-client-response'], 1);
      assert.equal((await call(agent, '/api/tracker/complaints?view=awaiting-client-response')).body.rows.length, 1);
      // The mention reaches the bell, pointing at the complaint.
      const bell = (await call(admin, '/api/notifications')).body;
      assert.equal(Number(bell.find((n) => n.kind === 'mention').complaint_record_id), Number(id));

      // A cleaner picked by id: the name is Launch27's, whatever the browser sends.
      const team = (await (await fetch(`${base}/l27/v1/staff/teams?limit=5`, { headers: { cookie: agent } })).json())[0];
      const picked = await call(agent, `/api/tracker/complaints/${id}`, 'PATCH', { cleaner_id: team.id, cleaner_name: 'Wrong Name' });
      assert.deepEqual([Number(picked.body.record.cleaner_id), picked.body.record.cleaner_name], [Number(team.id), cleanerTitle(team)]);
      assert.equal((await call(agent, `/api/tracker/complaints/${id}`, 'PATCH', { cleaner_id: 987654 })).status, 400);
      assert.equal((await call(agent, '/api/tracker/link-names', 'POST', {})).status, 403);
      assert.equal((await call(admin, '/api/tracker/link-names', 'POST', {})).status, 200);

      assert.equal((await call(agent, '/api/tracker/kustomer/load', 'POST', {})).status, 403);
      assert.equal((await call(admin, '/api/tracker/kustomer/load', 'POST', {})).status, 409, 'no Kustomer outside production');

      const am = (await call(agent, '/api/adjustments/meta')).body;
      assert.deepEqual([am.mode, am.net_impacts], ['sandbox', ['Addition', 'Deduction', 'Exception']]);
      const adj = await call(agent, '/api/adjustments', 'POST', { cleaner_name: 'Sample Cleaner', amount: 44, category: 'Client-Initiated Last Min Cancellation', net_impact: 'Addition', service_date: '2026-11-26', reason: 'Client not home' });
      assert.deepEqual([adj.status, adj.body.outcome], [201, 'sandbox']);
      assert.equal((await call(agent, '/api/adjustments', 'POST', { cleaner_name: 'Sample Cleaner' })).status, 400);
    } finally {
      await new Promise((r) => server.close(r));
      await db.close();
    }
  });
});
