// Kustomer historical migration: export (read-only), dry run, the prepared (disabled) import,
// and the admin API. All data is synthetic; nothing reaches Kustomer or Launch27.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { seed } from '../src/inbox/seed.js';
import * as svc from '../src/inbox/service.js';
import { createApp } from '../src/app.js';
import { createKustomerClient } from '../src/complaints/sources/kustomer.js';
import { createVault } from '../src/kustomer-migration/vault.js';
import { createKustomerSource } from '../src/kustomer-migration/source.js';
import { createKustomerExport, migrationDb } from '../src/kustomer-migration/export.js';
import { buildDirectory, createKustomerDryRun, matchCustomer, readOnlyDb } from '../src/kustomer-migration/dryrun.js';
import { createKustomerImporter, createKustomerImportJob, KUSTOMER_IMPORT_ENABLED } from '../src/kustomer-migration/import.js';
import { createKustomerMigration } from '../src/kustomer-migration/service.js';
import { createSyntheticKustomer } from '../src/kustomer-migration/synthetic.js';
import * as K from '../src/kustomer-migration/normalize.js';

const KEY = 'test-only-kustomer-export-key-0123456789abcdef';
const OURS = ['ourco.example'];

// Launch27 (synthetic): who is who.
const L27 = {
  customers: [
    { id: 1, email: 'alice@example.com', phone: '613-555-0101' },
    { id: 2, email: 'bob@example.com' },
    { id: 3, email: 'shared@example.com' },
    { id: 4, email: 'shared@example.com' },
    { id: 5, email: 'dana@example.com' },
    { id: 6, email: 'erin@example.com' },
  ],
  teams: [{ id: 10, email: 'casey@example.com', phone: '613-555-0110' }],
};
const l27Directory = async () => L27;

// ---- a small Kustomer, built record by record ----
let seq = 0;
const kid = (p) => `${p}${String(++seq).padStart(23, '0')}`;
function kustomer() {
  const data = { customers: [], conversations: new Map(), messages: new Map(), notes: new Map(), attachments: new Map() };
  const customer = (attrs) => {
    const c = { type: 'customer', id: kid('c'), attributes: { createdAt: '2019-01-01T00:00:00Z', ...attrs } };
    data.customers.push(c);
    data.conversations.set(c.id, []);
    return c;
  };
  const conversation = (c, { channel = 'email', at, msgs = [], notes = [], status = 'done', updatedAt } = {}) => {
    const v = { type: 'conversation', id: kid('v'), attributes: { name: `About ${channel}`, status, channels: [channel], createdAt: at, updatedAt: updatedAt || at, endedAt: status === 'done' ? at : undefined }, relationships: { customer: { data: { id: c.id } }, tags: { data: [{ id: 'tag-1' }] }, assignedUsers: { data: [{ id: 'u1' }] }, assignedTeams: { data: [{ id: 't1' }] } } };
    data.conversations.get(c.id).push(v);
    data.messages.set(
      v.id,
      msgs.map((m) => {
        const atts = (m.attachments || []).map((name) => {
          const a = { type: 'attachment', id: kid('a'), attributes: { name, contentType: 'application/pdf', contentLength: 2048 }, links: { self: 'https://api.kustomerapp.com/v1/attachments/x' } };
          data.attachments.set(a.id, a);
          return { id: a.id };
        });
        return { type: 'message', id: kid('m'), attributes: { channel: m.channel || channel, direction: m.dir || 'in', subject: m.subject, preview: (m.text || '').slice(0, 10), ...(m.previewOnly ? {} : { body: m.text }), createdAt: m.at, sentAt: m.at, meta: m.meta || {} }, relationships: { conversation: { data: { id: v.id } }, customer: { data: { id: c.id } }, attachments: { data: atts } } };
      }),
    );
    data.notes.set(v.id, notes.map((text) => ({ type: 'note', id: kid('n'), attributes: { body: text, createdAt: at }, relationships: { conversation: { data: { id: v.id } } } })));
    return v;
  };
  return { data, customer, conversation };
}

function scenario() {
  const k = kustomer();
  const c = {};
  c.alice = k.customer({ name: 'Alice', emails: [{ type: 'home', email: 'alice@example.com' }], phones: [{ phone: '613-555-0101' }] });
  c.aliceAgain = k.customer({ name: 'Alice (2)', emails: [{ type: 'home', email: 'ALICE@example.com' }] }); // duplicate identity
  c.shared = k.customer({ name: 'Shared', emails: [{ email: 'shared@example.com' }] }); // ambiguous
  c.conflict = k.customer({ name: 'Bob and Dana', emails: [{ email: 'bob@example.com' }, { email: 'dana@example.com' }] });
  c.secondary = k.customer({ name: 'Dana work', emails: [{ email: 'nobody@example.org' }, { email: 'dana.work@example.com' }] });
  c.contactPhone = k.customer({ name: 'Erin', phones: [{ phone: '(613) 555-0106' }] });
  c.phoneOnly = k.customer({ name: 'Phone only', phones: [{ phone: '613-555-0101' }] });
  c.cleaner = k.customer({ name: 'Casey', emails: [{ email: 'casey@example.com' }] });
  c.internal = k.customer({ name: 'Us', emails: [{ email: 'ops@ourco.example' }] });
  c.stranger = k.customer({ name: 'Stranger', emails: [{ email: 'stranger@example.org' }] });
  // Alice: an email thread in 2019 (with a note, an attachment, a message the inbox already has,
  // and one that only has a preview), and an SMS thread in 2025.
  const conv = {};
  conv.email2019 = k.conversation(c.alice, { channel: 'email', at: '2019-03-01T10:00:00Z', notes: ['VIP, prefers mornings'], msgs: [
    { dir: 'in', subject: 'Windows', text: 'Can you do windows?', at: '2019-03-01T10:00:00Z', meta: { from: 'alice@example.com', to: ['help@ourco.example'], messageId: '<already-1@example.com>' }, attachments: ['quote.pdf'] },
    { dir: 'out', subject: 'Re: Windows', text: 'Yes, we can.', at: '2019-03-01T12:00:00Z', meta: { from: 'help@ourco.example', to: ['alice@example.com'] } },
    { dir: 'in', subject: 'Re: Windows', text: 'Great, a long reply that Kustomer only previewed', at: '2019-03-02T08:00:00Z', previewOnly: true },
  ] });
  conv.sms2025 = k.conversation(c.alice, { channel: 'sms', at: '2025-06-01T15:00:00Z', msgs: [
    { dir: 'in', text: 'Running late?', at: '2025-06-01T15:00:00Z', meta: { from: '+16135550101', to: ['+16135550000'] } },
    { dir: 'out', text: 'She is 5 min away', at: '2025-06-01T15:02:00Z', meta: { from: '+16135550000', to: ['+16135550101'] } },
  ] });
  for (const x of [c.aliceAgain, c.shared, c.conflict, c.secondary, c.contactPhone, c.phoneOnly, c.cleaner, c.internal]) k.conversation(x, { channel: 'email', at: '2022-05-05T09:00:00Z', msgs: [{ dir: 'in', text: 'Hello', at: '2022-05-05T09:00:00Z' }] });
  conv.chat = k.conversation(c.stranger, { channel: 'chat', at: '2023-07-07T07:00:00Z', msgs: [{ dir: 'in', text: 'Do you clean offices?', at: '2023-07-07T07:00:00Z', channel: 'chat' }] });
  return { ...k, c, conv };
}

// Live inbox state the dry run must leave alone: contacts with established identities, and
// messages that arrived through the live channels after the cut-over.
async function liveFixtures(db) {
  await db.tx(async (q) => {
    await svc.createContact(q, { name: 'Dana', roles: ['customer'], l27_customer_id: 5, identities: [{ kind: 'email', value: 'dana@example.com' }, { kind: 'email', value: 'dana.work@example.com' }] });
    await svc.createContact(q, { name: 'Erin', roles: ['customer'], l27_customer_id: 6, identities: [{ kind: 'phone', value: '+16135550106' }] });
  });
  const email = await db.tx((q) => svc.ingestInbound(q, { channel: 'email', from: 'alice@example.com', to: 'help@ourco.example', subject: 'Windows', body: 'Can you do windows?', external_id: 'email:<already-1@example.com>', meta: { message_id: '<already-1@example.com>' }, at: new Date('2019-03-01T10:00:00Z') }));
  await db.tx((q) => svc.ingestInbound(q, { channel: 'sms', from: '+16135550101', to: '+16135550000', body: 'Running late?', external_id: 'tw:late', at: new Date('2025-06-01T15:00:20Z') }));
  return { emailConversation: Number(email.conversationId) };
}

const LIVE = ['contacts', 'contact_identities', 'conversations', 'messages', 'notifications', 'audit_log', 'users'];
async function liveSnapshot(db) {
  const out = {};
  for (const t of LIVE) out[t] = (await db.query(`SELECT * FROM ${t} ORDER BY 1, 2`)).rows;
  return JSON.stringify(out);
}

const vault = createVault(KEY);
const sourceOf = (client) => ({ kind: 'synthetic', source: createKustomerSource(client, { rpm: 100_000 }) });

// ---------------------------------------------------------------------------------------

describe('Kustomer client: paging, rate limits and failures', () => {
  test('follows links.next across pages and retries 429 (Retry-After) and 5xx', async () => {
    const waits = [];
    let calls = 0;
    const total = 250;
    const fetchImpl = async (url) => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ errors: [{ title: 'Too many requests' }] }), { status: 429, headers: { 'retry-after': '3' } });
      if (calls === 3) return new Response('{}', { status: 503 });
      const u = new URL(url);
      const page = Number(u.searchParams.get('page'));
      const size = Number(u.searchParams.get('pageSize'));
      const data = Array.from({ length: Math.max(0, Math.min(size, total - (page - 1) * size)) }, (_, i) => ({ type: 'customer', id: `c${(page - 1) * size + i}`, attributes: {} }));
      return Response.json({ data, links: { next: page * size < total ? `/v1/customers?page=${page + 1}&pageSize=${size}` : null } });
    };
    const src = createKustomerSource(createKustomerClient({ apiKey: 'k', fetchImpl, sleep: async (ms) => waits.push(ms) }), { rpm: 100_000 });
    const ids = [];
    let link = null;
    do {
      const p = await src.customersPage(link);
      ids.push(...p.records.map((r) => r.id));
      link = p.next;
    } while (link);
    assert.equal(ids.length, total);
    assert.equal(new Set(ids).size, total);
    assert.equal(waits[0], 3000); // Retry-After honoured
    assert.equal(waits.length, 2);
  });

  test('requests are paced to the configured rate', async () => {
    let t = 0;
    const sleeps = [];
    const src = createKustomerSource({ get: async () => ({ data: [] }) }, { rpm: 120, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    for (let i = 0; i < 4; i++) await src.customer('x');
    assert.deepEqual(sleeps, [500, 500, 500]); // 120 a minute = one every 500 ms
    assert.equal(src.requests(), 4);
  });

  test('the connection test names what the key cannot read', async () => {
    const s = scenario();
    const client = createSyntheticKustomer(s.data, { hooks: { beforeGet: (path) => { if (path.endsWith('/notes')) throw Object.assign(new Error('Kustomer /v1/conversations/:id/notes returned 403 (missing role)'), { status: 403 }); } } });
    const r = await createKustomerSource(client).testConnection();
    assert.equal(r.ok, false);
    const notes = r.checks.find((c) => c.name === 'Conversation notes');
    assert.equal(notes.ok, false);
    assert.match(notes.hint, /read role/);
    assert.ok(r.checks.filter((c) => c.name !== 'Conversation notes').every((c) => c.ok));
  });
});

describe('matching', () => {
  const contacts = [
    { kind: 'email', value: 'dana.work@example.com', contact_id: 1, l27_customer_id: 5 },
    { kind: 'phone', value: '+16135550106', contact_id: 2, l27_customer_id: 6 },
  ];
  const dir = buildDirectory({ ...L27, contacts, ourDomains: OURS });
  const m = (attrs) => matchCustomer(K.customer({ id: 'x', attributes: attrs }), dir);

  test('email first, then secondary addresses, then identities agents linked, then phones', () => {
    assert.deepEqual(m({ emails: [{ email: 'Alice@Example.com' }] }), { match: 'confident', target: 'customer', l27_customer_id: 1, method: 'email', candidates: [1] });
    assert.equal(m({ emails: [{ email: 'nobody@example.org' }, { email: 'dana.work@example.com' }] }).method, 'secondary_email');
    assert.deepEqual(m({ phones: [{ phone: '613 555 0106' }] }), { match: 'confident', target: 'customer', l27_customer_id: 6, method: 'contact', candidates: [6] });
    const phone = m({ phones: [{ phone: '613-555-0101' }] });
    assert.equal(phone.match, 'phone');
    assert.equal(phone.target, 'customer'); // a phone match goes on that customer's Story too
    assert.equal(phone.l27_customer_id, 1);
  });

  test('several Launch27 customers: one is picked by rule, and the reason never names an address', () => {
    const shared = m({ emails: [{ email: 'shared@example.com' }] });
    assert.equal(shared.match, 'picked');
    assert.equal(shared.target, 'customer');
    assert.equal(shared.l27_customer_id, 4); // no creation dates: the highest id
    assert.deepEqual(shared.candidates.sort(), [3, 4]);
    assert.match(shared.reason, /primary address is on 2 Launch27 customers: picked the most recently created/);
    // The most recently created wins…
    const dated = buildDirectory({ customers: [{ id: 3, email: 'shared@example.com', created_at: '2024-01-01T00:00:00Z' }, { id: 4, email: 'shared@example.com', created_at: '2020-01-01T00:00:00Z' }], ourDomains: OURS });
    assert.equal(matchCustomer(K.customer({ id: 'x', attributes: { emails: [{ email: 'shared@example.com' }] } }), dated).l27_customer_id, 3);
    // …unless agents already linked one of them.
    const linked = buildDirectory({ ...L27, contacts: [{ kind: 'email', value: 'shared@example.com', contact_id: 9, l27_customer_id: 3 }], ourDomains: OURS });
    const l = matchCustomer(K.customer({ id: 'x', attributes: { emails: [{ email: 'shared@example.com' }] } }), linked);
    assert.equal(l.l27_customer_id, 3);
    assert.match(l.reason, /agents already linked/);
    // Addresses on different customers: the primary address decides.
    const conflict = m({ emails: [{ email: 'bob@example.com' }, { email: 'dana@example.com' }] });
    assert.deepEqual([conflict.match, conflict.l27_customer_id, conflict.method], ['picked', 2, 'email']);
    assert.deepEqual(conflict.candidates.sort(), [2, 5]);
    for (const r of [shared.reason, l.reason, conflict.reason]) assert.ok(!r.includes('@'), r);
  });

  test('cleaners, inbox contacts, internal accounts and strangers all get a target', () => {
    assert.deepEqual(m({ emails: [{ email: 'casey@example.com' }] }), { match: 'cleaner', target: 'cleaner', l27_team_id: 10, method: 'email', candidates: [], reason: 'a Launch27 cleaner' });
    assert.equal(m({ phones: [{ phone: '613-555-0110' }] }).l27_team_id, 10);
    assert.deepEqual([m({ emails: [{ email: 'ops@ourco.example' }] }).match, m({ emails: [{ email: 'ops@ourco.example' }] }).target], ['internal', 'new']);
    assert.deepEqual([m({ emails: [{ email: 'stranger@example.org' }] }).match, m({ emails: [{ email: 'stranger@example.org' }] }).target], ['new_profile', 'new']);
    assert.equal(m({ name: 'Alice' }).match, 'new_profile'); // never by name
    assert.equal(m({ name: 'Alice' }).reason, 'no email or phone in Kustomer');
    // A contact already in the inbox, not in Launch27: by email, or by phone when there's no email.
    const inbox = buildDirectory({ ...L27, contacts: [...contacts, { kind: 'email', value: 'lead@example.org', contact_id: 7 }, { kind: 'phone', value: '+16135550177', contact_id: 8 }, { kind: 'email', value: 'jo@ourco.example', contact_id: 11 }], ourDomains: OURS });
    const mi = (attrs) => matchCustomer(K.customer({ id: 'x', attributes: attrs }), inbox);
    assert.deepEqual(mi({ emails: [{ email: 'lead@example.org' }] }), { match: 'existing', target: 'contact', contact_id: 7, method: 'email', candidates: [], reason: 'a contact already in the inbox, not in Launch27' });
    assert.equal(mi({ phones: [{ phone: '613-555-0177' }] }).contact_id, 8);
    assert.equal(mi({ emails: [{ email: 'new@example.org' }], phones: [{ phone: '613-555-0177' }] }).match, 'new_profile'); // a shared phone isn't enough when they have their own email
    assert.deepEqual([mi({ emails: [{ email: 'jo@ourco.example' }] }).match, mi({ emails: [{ email: 'jo@ourco.example' }] }).contact_id], ['internal', 11]);
    // Launch27 still comes first.
    assert.equal(mi({ emails: [{ email: 'lead@example.org' }], phones: [{ phone: '613-555-0101' }] }).l27_customer_id, 1);
  });
});

describe('export and dry run', () => {
  let db;
  let s;
  let client;
  let exporter;
  let job;
  let fixtures;
  let before0;
  let results;

  before(async () => {
    db = await openDb();
    await seed(db);
    fixtures = await liveFixtures(db);
    before0 = await liveSnapshot(db);
    s = scenario();
    client = createSyntheticKustomer(s.data);
    exporter = createKustomerExport({ db, vault, getSource: async () => sourceOf(client) });
    job = await exporter.create({ id: null }, {});
    await exporter.wait(job.id);
    job = await exporter.detail(job.id);
    const dry = createKustomerDryRun({ db, vault, l27Directory, ourDomains: OURS });
    const run = await dry.start({ id: null });
    await dry.wait();
    results = (await db.query('SELECT * FROM kustomer_dry_runs WHERE id = $1', [run.id])).rows[0];
  });
  after(() => db.close());

  test('exports every customer, conversation, message, note and attachment, once', async () => {
    assert.equal(job.status, 'completed', job.last_error);
    assert.deepEqual(job.customers, { pending: 0, done: 10, failed: 0, skipped: 0 });
    const counts = Object.fromEntries((await db.query('SELECT kind, count(*)::int AS n FROM kustomer_records GROUP BY kind')).rows.map((r) => [r.kind, r.n]));
    assert.deepEqual(counts, { customer: 10, conversation: 11, message: 14, note: 1, attachment: 1 });
    // Nothing but GET was ever sent to Kustomer.
    assert.equal(client.calls.get > 0, true);
  });

  test('records are encrypted; ids, dates and channels stay readable for the report', async () => {
    const rows = (await db.query('SELECT kind, data, source_created_at, channel, direction FROM kustomer_records')).rows;
    const blob = Buffer.concat(rows.map((r) => Buffer.from(r.data))).toString('latin1');
    for (const secret of ['alice@example.com', 'Can you do windows', 'VIP, prefers mornings', 'Alice']) assert.ok(!blob.includes(secret), secret);
    const msg = rows.find((r) => r.kind === 'message' && r.channel === 'sms' && r.direction === 'out');
    assert.equal(new Date(msg.source_created_at).toISOString(), '2025-06-01T15:02:00.000Z');
    assert.throws(() => createVault('another-key-another-key-another-key').open(rows[0].data));
    assert.equal(vault.open(rows.find((r) => r.kind === 'note').data).attributes.body, 'VIP, prefers mornings');
  });

  test('dry run: multi-year, multi-channel history with original dates and directions', () => {
    const r = results.results;
    assert.equal(results.status, 'completed', results.last_error);
    assert.deepEqual(r.by_channel, { email: 11, sms: 2, chat: 1 });
    assert.deepEqual(r.by_direction, { in: 12, out: 2, unknown: 0 });
    assert.equal(r.oldest, '2019-03-01T10:00:00.000Z');
    assert.equal(r.newest, '2025-06-01T15:02:00.000Z');
    assert.equal(r.notes, 1);
    assert.equal(r.attachments, 1);
  });

  test('dry run: each kind of match, every profile has a target, and duplicate identities', () => {
    const r = results.results;
    assert.equal(r.plan_version, 2);
    assert.deepEqual(r.match, { confident: 4, phone: 1, picked: 2, cleaner: 1, existing: 0, internal: 1, new_profile: 1 });
    assert.deepEqual(r.by_target, { customer: 7, cleaner: 1, contact: 0, new: 2 });
    assert.equal(r.new_profiles, 2); // the internal account and the stranger
    assert.equal(r.duplicate_identities, 2); // Alice's second profile, and the phone-only profile that is also Alice
  });

  test('dry run: messages the live inbox already has are duplicates; preview-only messages are counted', async () => {
    const plan = (await db.query('SELECT * FROM kustomer_plan_conversations WHERE run_id = $1 AND kustomer_conversation_id = ANY($2::text[]) ORDER BY first_at', [results.id, [s.conv.email2019.id, s.conv.sms2025.id]])).rows;
    assert.deepEqual(plan.map((p) => [p.l27_customer_id && Number(p.l27_customer_id), p.action, p.messages, p.duplicate_messages, p.preview_only_messages, p.notes]), [[1, 'new', 3, 1, 1, 1], [1, 'new', 2, 1, 0, 0]]);
    assert.equal(results.results.duplicate_messages, 2);
    assert.equal(new Date(plan[0].first_at).toISOString(), '2019-03-01T10:00:00.000Z');
  });

  test('people Launch27 does not know are planned onto a new profile', async () => {
    const p = (await db.query('SELECT * FROM kustomer_plan_conversations WHERE run_id = $1 AND kustomer_conversation_id = $2', [results.id, s.conv.chat.id])).rows[0];
    assert.equal(p.kustomer_customer_id, s.c.stranger.id);
    assert.equal(p.l27_customer_id, null);
    assert.equal(p.match, 'new_profile');
    assert.equal(p.action, 'new');
    const who = (await db.query('SELECT kustomer_customer_id, target, l27_customer_id, l27_team_id FROM kustomer_plan_customers WHERE run_id = $1 AND kustomer_customer_id = ANY($2::text[])', [results.id, [s.c.stranger.id, s.c.cleaner.id, s.c.shared.id]])).rows;
    const by = Object.fromEntries(who.map((w) => [w.kustomer_customer_id, w]));
    assert.equal(by[s.c.stranger.id].target, 'new');
    assert.deepEqual([by[s.c.cleaner.id].target, Number(by[s.c.cleaner.id].l27_team_id)], ['cleaner', 10]);
    assert.deepEqual([by[s.c.shared.id].target, Number(by[s.c.shared.id].l27_customer_id)], ['customer', 4]);
  });

  test('zero side effects: the live inbox is exactly as before', async () => {
    assert.equal(await liveSnapshot(db), before0);
    assert.throws(() => readOnlyDb(db).query('INSERT INTO contacts (name) VALUES ($1)', ['x']), /write/);
    assert.throws(() => migrationDb(db).query("UPDATE conversations SET status = 'done'"), /outside its own tables/);
    assert.ok(fixtures.emailConversation > 0);
  });

  test('a catch-up export re-reads only conversations that changed', async () => {
    const changed = s.data.conversations.get(s.c.alice.id)[1];
    changed.attributes.updatedAt = '2026-11-01T00:00:00Z';
    s.data.messages.get(changed.id).push({ type: 'message', id: kid('m'), attributes: { channel: 'sms', direction: 'in', body: 'One more thing', preview: 'One more', createdAt: '2026-11-01T00:00:00Z' }, relationships: { conversation: { data: { id: changed.id } } } });
    s.c.alice.attributes.updatedAt = '2026-11-01T00:00:00Z';
    const calls = client.calls.get;
    let j = await exporter.create({ id: null }, { kind: 'catchup', since: '2026-10-01' });
    await exporter.wait(j.id);
    j = await exporter.detail(j.id);
    assert.equal(j.status, 'completed', j.last_error);
    assert.equal(j.customers.done, 1); // only Alice was active since then
    assert.equal((await db.query("SELECT count(*)::int AS n FROM kustomer_records WHERE kind = 'message'")).rows[0].n, 15);
    // Only the changed conversation's messages and notes were fetched again (2 calls), plus the
    // customer list and Alice's conversation list.
    assert.ok(client.calls.get - calls <= 4, `calls ${client.calls.get - calls}`);
  });
});

describe('resuming', () => {
  test('pause, an outage and a refused key: resumed to the same result as one clean run', async () => {
    const db = await openDb();
    await seed(db);
    const s = scenario();
    let fail = 0;
    let deny = false;
    const client = createSyntheticKustomer(s.data, {
      hooks: {
        beforeGet: async (path, q) => {
          if (path === '/v1/customers' && Number(q.page) === 1 && Number(q.pageSize) === 3) await db.query("UPDATE kustomer_export_jobs SET status = 'paused' WHERE status = 'running'");
          if (path.endsWith('/messages') && fail-- > 0) throw Object.assign(new Error('Kustomer 500'), { status: 500 });
          if (deny && path.endsWith('/notes')) throw Object.assign(new Error('Kustomer returned 403'), { status: 403 });
        },
      },
    });
    // Small pages so the customer list takes several pages.
    const small = { get: (p, q) => client.get(p, q && q.pageSize === 100 ? { ...q, pageSize: 3 } : q) };
    const exporter = createKustomerExport({ db, vault, getSource: async () => sourceOf(small), concurrency: 1, batch: 2 });
    let j = await exporter.create({ id: null }, {});
    await exporter.wait(j.id);
    j = await exporter.detail(j.id);
    assert.equal(j.status, 'paused');
    assert.equal(j.phase, 'customers');
    assert.ok(j.next_link, 'checkpointed mid-list');
    fail = 5; // one customer's messages fail three times, then the next twice
    deny = false;
    await exporter.resume(j.id);
    await exporter.wait(j.id);
    j = await exporter.detail(j.id);
    assert.equal(j.status, 'completed', j.last_error);
    assert.equal(j.customers.failed, 1);
    assert.match(j.errors[0].error, /500/);
    deny = true; // the key loses a role: the job stops rather than failing every customer
    await exporter.resume(j.id);
    await exporter.wait(j.id);
    j = await exporter.detail(j.id);
    assert.equal(j.status, 'failed');
    assert.match(j.last_error, /403/);
    deny = false;
    await exporter.resume(j.id);
    await exporter.wait(j.id);
    j = await exporter.detail(j.id);
    assert.equal(j.status, 'completed');
    assert.deepEqual(j.customers, { pending: 0, done: 10, failed: 0, skipped: 0 });
    const counts = Object.fromEntries((await db.query('SELECT kind, count(*)::int AS n FROM kustomer_records GROUP BY kind')).rows.map((r) => [r.kind, r.n]));
    assert.deepEqual(counts, { customer: 10, conversation: 11, message: 14, note: 1, attachment: 1 });
    await exporter.recover();
    await db.close();
  });
});

describe('the import', () => {
  test('is switched on (approved); switched off, the importer refuses', async () => {
    assert.equal(KUSTOMER_IMPORT_ENABLED, true);
    const imp = createKustomerImporter({ db: null, vault, enabled: false });
    await assert.rejects(imp.importBatch(1, []), /not enabled/);
    await assert.rejects(imp.rollback(1), /not enabled/);
  });

  test('closed, idempotent, no side effects, rollback and reconcile', async () => {
    const db = await openDb();
    await seed(db);
    const fixtures = await liveFixtures(db);
    const s = scenario();
    const exporter = createKustomerExport({ db, vault, getSource: async () => sourceOf(createSyntheticKustomer(s.data)) });
    const j = await exporter.create({ id: null }, {});
    await exporter.wait(j.id);
    const dry = createKustomerDryRun({ db, vault, l27Directory, ourDomains: OURS });
    const run = await dry.start({ id: null });
    await dry.wait();
    const liveBefore = (await db.query('SELECT * FROM conversations WHERE id = $1', [fixtures.emailConversation])).rows[0];
    const notificationsBefore = (await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n;
    const plans = (await db.query('SELECT c.*, p.contact_id, p.target, p.l27_team_id FROM kustomer_plan_conversations c JOIN kustomer_plan_customers p USING (run_id, kustomer_customer_id) WHERE c.run_id = $1 AND c.kustomer_customer_id = $2', [run.id, s.c.alice.id])).rows;
    const imp = createKustomerImporter({ db, vault, enabled: true });
    const isDuplicate = (m) => m.email_message_id === '<already-1@example.com>' || m.body === 'Running late?';
    const first = await imp.importBatch(77, plans, { isDuplicate });
    assert.deepEqual(first, { conversations: 2, messages: 3, notes: 1, skipped: 0, profiles: 0 });
    const again = await imp.importBatch(77, plans, { isDuplicate });
    assert.deepEqual(again, { conversations: 0, messages: 0, notes: 0, skipped: 2, profiles: 0 }); // idempotent
    const convs = (await db.query("SELECT * FROM conversations WHERE source = 'kustomer' ORDER BY created_at")).rows;
    assert.equal(convs.length, 2);
    for (const c of convs) {
      assert.equal(c.status, 'done');
      assert.equal(c.owner_id, null);
      assert.equal(c.queue_id, null);
      assert.equal(c.sla_due_at, null);
      assert.equal(c.awaiting_reply_since, null);
      assert.equal(Number(c.import_run_id), 77);
    }
    assert.equal(new Date(convs[0].created_at).toISOString(), '2019-03-01T10:00:00.000Z');
    assert.deepEqual(convs[0].source_meta.tags, ['tag-1']);
    // Shown on Alice's Story: one contact for Launch27 customer 1 (created once, never twice).
    const contacts = (await db.query('SELECT id FROM contacts WHERE l27_customer_id = 1')).rows;
    assert.equal(contacts.length, 1);
    assert.ok(convs.every((c) => Number(c.contact_id) === Number(contacts[0].id)));
    const note = (await db.query("SELECT * FROM messages WHERE kind = 'note' AND external_id LIKE 'kustomer:%'")).rows[0];
    assert.equal(note.body, 'VIP, prefers mornings');
    const msgs = (await db.query("SELECT direction, delivery_state, created_at FROM messages WHERE kind = 'message' AND external_id LIKE 'kustomer:%' ORDER BY created_at")).rows;
    assert.deepEqual(msgs.map((m) => [m.direction, m.delivery_state]), [['out', 'historical'], ['in', 'historical'], ['out', 'historical']]);
    // Nothing live changed: the existing conversation, notifications, no reply sent.
    assert.deepEqual((await db.query('SELECT * FROM conversations WHERE id = $1', [fixtures.emailConversation])).rows[0], liveBefore);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n, notificationsBefore);
    const rec = await imp.reconcile(run.id, 77);
    assert.equal(rec.imported, 2);
    assert.deepEqual(rec.different, []);
    assert.equal(rec.without_customer, 0);
    assert.deepEqual(await imp.rollback(77), { conversations: 2, profiles: 0 });
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE external_id LIKE 'kustomer:%'")).rows[0].n, 0);
    await db.close();
  });

  test('every conversation goes to someone: customers, cleaners, inbox contacts and new profiles', async () => {
    const db = await openDb();
    await seed(db);
    await liveFixtures(db);
    // Someone the inbox already knows (not in Launch27), with an email and a phone.
    const lead = await db.tx((q) => svc.createContact(q, { name: 'Lead', roles: [], identities: [{ kind: 'email', value: 'lead@example.org' }, { kind: 'phone', value: '+16135550177' }] }));
    const s = scenario();
    const extra = {
      lead: s.customer({ name: 'Lead in Kustomer', emails: [{ email: 'lead@example.org' }] }),
      twin: s.customer({ name: 'Stranger again', emails: [{ email: 'stranger@example.org' }], phones: [{ phone: '613-555-0199' }] }), // same person, second Kustomer profile
      sharesPhone: s.customer({ name: 'Other', emails: [{ email: 'other@example.org' }], phones: [{ phone: '613-555-0177' }] }), // their own email; Lead's phone
    };
    for (const x of Object.values(extra)) s.conversation(x, { channel: 'email', at: '2024-02-02T09:00:00Z', msgs: [{ dir: 'in', text: 'Hi', at: '2024-02-02T09:00:00Z' }] });
    s.customer({ name: 'No conversations', emails: [{ email: 'quiet@example.org' }] }); // nothing to import: no profile
    const migration = createKustomerMigration({ db, config: { production: false, kustomerExportKey: KEY }, l27Directory, ourDomains: OURS, sourceOverride: sourceOf(createSyntheticKustomer(s.data)) });
    const ex = await migration.startExport({ id: null }, {});
    await migration._export.wait(ex.id);
    await migration.startDryRun({ id: null });
    await migration._dryRun.wait();
    // A plan from before this change can't be imported.
    await db.query("UPDATE kustomer_dry_runs SET results = results - 'plan_version'");
    await assert.rejects(migration.startImport({ id: null }), /run the dry run again/);
    await db.query("UPDATE kustomer_dry_runs SET results = jsonb_set(results, '{plan_version}', '2')");
    const notificationsBefore = (await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n;
    const identitiesBefore = (await db.query('SELECT * FROM contact_identities ORDER BY id')).rows;

    const started = await migration.startImport({ id: null });
    await migration._imports.wait();
    const run = await migration._imports.get(started.id);
    assert.equal(run.status, 'completed', run.last_error);
    assert.equal(run.conversations, 14);
    assert.equal(run.reconcile.without_customer, 0);
    assert.equal(run.reconcile.missing, 0);

    const onContact = async (kustomerCustomer) => (await db.query("SELECT c.contact_id FROM conversations c WHERE c.source = 'kustomer' AND c.source_meta->>'kustomer_customer_id' = $1", [kustomerCustomer.id])).rows.map((r) => Number(r.contact_id));
    const contactOf = async (col, id) => Number((await db.query(`SELECT id FROM contacts WHERE ${col} = $1 ORDER BY id LIMIT 1`, [id])).rows[0].id);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM conversations WHERE source = 'kustomer' AND (contact_id IS NULL OR needs_match)")).rows[0].n, 0);
    // Launch27 customers: by email, a picked one of several, by phone only.
    const alice = await contactOf('l27_customer_id', 1);
    assert.deepEqual([...new Set([...(await onContact(s.c.alice)), ...(await onContact(s.c.aliceAgain)), ...(await onContact(s.c.phoneOnly))])], [alice]);
    assert.deepEqual(await onContact(s.c.shared), [await contactOf('l27_customer_id', 4)]);
    assert.deepEqual(await onContact(s.c.conflict), [await contactOf('l27_customer_id', 2)]);
    // The cleaner's profile.
    const casey = (await db.query('SELECT * FROM contacts WHERE l27_team_id = 10')).rows;
    assert.equal(casey.length, 1);
    assert.deepEqual(casey[0].roles, ['cleaner']);
    assert.deepEqual(await onContact(s.c.cleaner), [Number(casey[0].id)]);
    // A contact the inbox already had: used as it is.
    assert.deepEqual(await onContact(extra.lead), [Number(lead.id)]);
    // New profiles: the internal account, and the stranger (both Kustomer profiles on one).
    const us = (await db.query("SELECT c.*, k.kind FROM contacts c JOIN kustomer_contacts k ON k.contact_id = c.id WHERE c.name = 'Us'")).rows[0];
    assert.deepEqual([us.kind, us.roles, us.l27_customer_id], ['internal', ['customer'], null]);
    assert.deepEqual(await onContact(s.c.internal), [Number(us.id)]);
    const stranger = (await db.query("SELECT * FROM contacts WHERE name = 'Stranger'")).rows;
    assert.equal(stranger.length, 1);
    assert.deepEqual([...(await onContact(s.c.stranger)), ...(await onContact(extra.twin))], [Number(stranger[0].id), Number(stranger[0].id)]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM contacts WHERE name = 'Stranger again'")).rows[0].n, 0);
    // A new profile never takes an identity another contact has: Lead keeps getting their texts.
    const other = (await db.query("SELECT id FROM contacts WHERE name = 'Other'")).rows[0];
    assert.deepEqual((await db.query('SELECT kind, value FROM contact_identities WHERE contact_id = $1', [other.id])).rows, [{ kind: 'email', value: 'other@example.org' }]);
    assert.deepEqual((await db.query('SELECT * FROM contact_identities WHERE id = ANY($1::bigint[]) ORDER BY id', [identitiesBefore.map((i) => i.id)])).rows, identitiesBefore); // existing contacts unchanged
    assert.equal(run.profiles, 3);
    assert.equal((await migration._dryRun.latest()).results.new_profiles, 3); // the dry run's estimate
    assert.equal((await db.query("SELECT count(*)::int AS n FROM contacts WHERE name = 'No conversations'")).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n, notificationsBefore);

    // A new profile that has since received a live email is kept by a rollback; the others go.
    const live = await db.tx((q) => svc.ingestInbound(q, { channel: 'email', from: 'stranger@example.org', to: 'help@ourco.example', subject: 'Back again', body: 'Hello again', external_id: 'email:<back@example.org>' }));
    const conv = (await db.query('SELECT contact_id FROM conversations WHERE id = $1', [live.conversationId])).rows[0];
    assert.equal(Number(conv.contact_id), Number(stranger[0].id));
    const rolled = await migration.importAction({ id: null }, run.id, 'rollback');
    assert.equal(rolled.rolled_back_conversations, 14);
    assert.equal(rolled.rolled_back_profiles, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1::bigint[])', [[us.id, other.id]])).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1::bigint[])', [[stranger[0].id, lead.id, casey[0].id]])).rows[0].n, 3);
    await db.close();
  });
});

describe('admin page API', () => {
  let db;
  let server;
  let base;
  let migration;
  before(async () => {
    db = await openDb();
    await seed(db);
    const s = scenario();
    migration = createKustomerMigration({ db, config: { production: false, kustomerExportKey: KEY }, l27Directory, ourDomains: OURS, sourceOverride: sourceOf(createSyntheticKustomer(s.data)) });
    server = createApp({ l27BaseUrl: 'https://l27.invalid', sessionSecret: 's', production: false, adminEmails: 'boss@example.com' }, { db, fetchImpl: async () => Response.json({ bearer: 'tok' }), kustomerMigration: migration }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.close();
    await db.close();
  });
  const login = async (email) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'x' }) })).headers.get('set-cookie').split(';')[0];
  const call = async (cookie, path, body, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  test('everyone on the team can test, export, dry-run and download a sanitized report', async () => {
    const admin = await login('boss@example.com');
    await call(admin, '/me'); // the first person in becomes an admin
    const agent = await login('agent@example.com');
    assert.equal((await call(agent, '/me')).body.role, 'agent');
    assert.equal((await call(agent, '/admin/kustomer')).status, 200); // not admins only
    assert.equal((await fetch(`${base}/api/admin/kustomer`)).status, 401); // but signed in
    const o = await call(admin, '/admin/kustomer');
    assert.equal(o.body.available, true);
    assert.equal(o.body.import_enabled, true);
    assert.deepEqual(o.body.imports, []);
    assert.equal((await call(admin, '/admin/kustomer/test', {})).body.ok, true);
    assert.equal((await call(admin, '/admin/kustomer/dry-runs', {})).status, 409); // nothing exported yet
    const started = await call(admin, '/admin/kustomer/exports', { kind: 'full' });
    assert.equal(started.status, 201);
    await migration._export.wait(started.body.id);
    assert.equal((await call(admin, '/admin/kustomer/exports', { kind: 'catchup' })).status, 400); // needs a date
    assert.equal((await call(admin, '/admin/kustomer/dry-runs', {})).status, 201);
    await migration._dryRun.wait();
    const matches = await call(admin, '/admin/kustomer/matches?match=confident');
    assert.equal(matches.body.rows.length, 2); // no linked contacts in this database: only Alice's two profiles
    assert.ok(matches.body.rows.some((r) => r.name === 'Alice'));
    const report = await call(admin, '/admin/kustomer/report.csv');
    assert.equal(report.status, 200);
    assert.match(report.headers.get('content-type'), /csv/);
    assert.equal(report.text.trim().split('\n').length, 12); // header + 11 conversations
    for (const secret of ['Alice', 'alice@example.com', 'windows', '613']) assert.ok(!report.text.includes(secret), secret);
    assert.equal((await call(agent, '/admin/kustomer/report.csv')).status, 200);
    assert.equal((await call(agent, '/admin/kustomer/purge', {})).status, 200);
    assert.deepEqual((await call(admin, '/admin/kustomer')).body.stored, {});
  });

  test('an agent imports the plan in batches, with progress, stop/resume, a check and rollback', async () => {
    const agent = await login('agent@example.com');
    assert.equal((await call(agent, '/admin/kustomer/imports', {})).status, 409); // nothing exported or planned
    const ex = await call(agent, '/admin/kustomer/exports', { kind: 'full' });
    assert.equal(ex.status, 201);
    await migration._export.wait(ex.body.id);
    assert.equal((await call(agent, '/admin/kustomer/imports', {})).status, 409); // no dry run yet
    assert.equal((await call(agent, '/admin/kustomer/dry-runs', {})).status, 201);
    await migration._dryRun.wait();
    const planned = (await call(agent, '/admin/kustomer')).body.dry_run.results.new_conversations;
    assert.ok(planned > 0);
    const notificationsBefore = (await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n;
    const liveBefore = (await db.query("SELECT id, status, updated_at FROM conversations WHERE source IS NULL ORDER BY id")).rows;

    const started = await call(agent, '/admin/kustomer/imports', {});
    assert.equal(started.status, 201);
    assert.equal(started.body.planned, planned);
    await migration._imports.wait();
    let run = (await call(agent, '/admin/kustomer')).body.imports[0];
    assert.equal(run.status, 'completed');
    assert.equal(run.processed, planned);
    assert.equal(run.conversations, planned);
    assert.ok(run.batches >= 1);
    assert.equal(run.reconcile.planned, planned);
    assert.equal(run.reconcile.imported, planned);
    assert.equal(run.reconcile.missing, 0);
    assert.equal(run.reconcile.different, 0);
    const imported = (await db.query("SELECT status, owner_id, queue_id, import_run_id FROM conversations WHERE source = 'kustomer'")).rows;
    assert.equal(imported.length, planned);
    assert.ok(imported.every((c) => c.status === 'done' && c.owner_id === null && c.queue_id === null && Number(c.import_run_id) === run.id));
    // Nothing live changed and no one was notified; nothing was sent.
    assert.deepEqual((await db.query("SELECT id, status, updated_at FROM conversations WHERE source IS NULL ORDER BY id")).rows, liveBefore);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n, notificationsBefore);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE external_id LIKE 'kustomer:%' AND delivery_state <> 'historical' AND kind = 'message'")).rows[0].n, 0);

    // Importing the same plan again adds nothing.
    const again = await call(agent, '/admin/kustomer/imports', {});
    await migration._imports.wait();
    const second = (await call(agent, '/admin/kustomer')).body.imports[0];
    assert.equal(second.id, again.body.id);
    assert.equal(second.conversations, 0);
    assert.equal(second.skipped, planned);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM conversations WHERE source = 'kustomer'")).rows[0].n, planned);

    // Roll back the first run: its conversations, messages and notes go.
    assert.equal((await call(agent, `/admin/kustomer/imports/${run.id}/resume`, {})).status, 409); // only stopped or failed runs resume
    const rb = await call(agent, `/admin/kustomer/imports/${run.id}/rollback`, {});
    assert.equal(rb.status, 200);
    assert.equal(rb.body.status, 'rolled_back');
    assert.equal(rb.body.rolled_back_conversations, planned);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM conversations WHERE source = 'kustomer'")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE external_id LIKE 'kustomer:%'")).rows[0].n, 0);
    assert.equal((await call(agent, `/admin/kustomer/imports/${run.id}/rollback`, {})).status, 409);
    assert.deepEqual((await db.query("SELECT id, status, updated_at FROM conversations WHERE source IS NULL ORDER BY id")).rows, liveBefore);

    // Stop after the first batch, a restart, then resume to the same result.
    const small = migration._imports;
    const job = createKustomerImportJob({ db, importer: createKustomerImporter({ db, vault: migration._vault }), dedupe: (m) => migration._dryRun.duplicates(m), batch: 1 });
    const dryRunId = (await call(agent, '/admin/kustomer')).body.dry_run;
    const r3 = await job.start({ id: null }, dryRunId);
    await assert.rejects(job.start({ id: null }, dryRunId), /already running/); // one at a time
    await job.stop(r3.id);
    await job.wait();
    let mid = await job.get(r3.id);
    assert.equal(mid.status, 'stopped');
    assert.ok(mid.processed >= 1 && mid.processed < planned);
    await job.resume(r3.id);
    await job.wait();
    mid = await job.get(r3.id);
    assert.equal(mid.status, 'completed');
    assert.equal(mid.conversations, planned);
    assert.equal(mid.batches, planned);
    assert.equal(mid.reconcile.missing, 0);
    assert.equal((await small.list())[0].id, r3.id);
    await job.rollback({ id: null }, r3.id);
  });
});
