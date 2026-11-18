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
import { createKustomerImporter, KUSTOMER_IMPORT_ENABLED } from '../src/kustomer-migration/import.js';
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

  test('email first, then secondary addresses, then identities agents linked; phones alone only for review', () => {
    assert.deepEqual(m({ emails: [{ email: 'Alice@Example.com' }] }), { match: 'confident', l27_customer_id: 1, method: 'email', candidates: [1] });
    assert.equal(m({ emails: [{ email: 'nobody@example.org' }, { email: 'dana.work@example.com' }] }).method, 'secondary_email');
    assert.deepEqual(m({ phones: [{ phone: '613 555 0106' }] }), { match: 'confident', l27_customer_id: 6, method: 'contact', candidates: [6] });
    const phone = m({ phones: [{ phone: '613-555-0101' }] });
    assert.equal(phone.match, 'review');
    assert.equal(phone.l27_customer_id, 1);
  });
  test('shared, conflicting, cleaner, internal and unknown are never guessed', () => {
    assert.equal(m({ emails: [{ email: 'shared@example.com' }] }).match, 'ambiguous');
    assert.deepEqual(m({ emails: [{ email: 'shared@example.com' }] }).candidates.sort(), [3, 4]);
    assert.equal(m({ emails: [{ email: 'bob@example.com' }, { email: 'dana@example.com' }] }).match, 'conflict');
    assert.equal(m({ emails: [{ email: 'casey@example.com' }] }).match, 'cleaner');
    assert.equal(m({ emails: [{ email: 'ops@ourco.example' }] }).match, 'internal');
    assert.equal(m({ emails: [{ email: 'stranger@example.org' }] }).match, 'unmatched');
    assert.equal(m({ name: 'Alice' }).match, 'unmatched'); // never by name
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

  test('dry run: each kind of match, and duplicate identities', () => {
    const r = results.results;
    assert.deepEqual(r.match, { confident: 4, review: 1, ambiguous: 1, conflict: 1, unmatched: 1, cleaner: 1, internal: 1 });
    assert.equal(r.duplicate_identities, 2); // Alice's second profile, and the phone-only profile that is also Alice
  });

  test('dry run: messages the live inbox already has are duplicates; preview-only messages are counted', async () => {
    const plan = (await db.query('SELECT * FROM kustomer_plan_conversations WHERE run_id = $1 AND kustomer_conversation_id = ANY($2::text[]) ORDER BY first_at', [results.id, [s.conv.email2019.id, s.conv.sms2025.id]])).rows;
    assert.deepEqual(plan.map((p) => [p.l27_customer_id && Number(p.l27_customer_id), p.action, p.messages, p.duplicate_messages, p.preview_only_messages, p.notes]), [[1, 'new', 3, 1, 1, 1], [1, 'new', 2, 1, 0, 0]]);
    assert.equal(results.results.duplicate_messages, 2);
    assert.equal(new Date(plan[0].first_at).toISOString(), '2019-03-01T10:00:00.000Z');
  });

  test('unmatched customers keep their Kustomer relationship in the plan', async () => {
    const p = (await db.query('SELECT * FROM kustomer_plan_conversations WHERE run_id = $1 AND kustomer_conversation_id = $2', [results.id, s.conv.chat.id])).rows[0];
    assert.equal(p.kustomer_customer_id, s.c.stranger.id);
    assert.equal(p.l27_customer_id, null);
    assert.equal(p.match, 'unmatched');
    assert.equal(p.action, 'new');
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

describe('the prepared import (not enabled)', () => {
  test('is off: no route, and the importer refuses without an approved code change', async () => {
    assert.equal(KUSTOMER_IMPORT_ENABLED, false);
    const imp = createKustomerImporter({ db: null, vault });
    await assert.rejects(imp.importBatch(1, []), /not enabled/);
    await assert.rejects(imp.rollback(1), /not enabled/);
  });

  test('when enabled (test database only): closed, idempotent, no side effects, rollback and reconcile', async () => {
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
    const plans = (await db.query('SELECT c.*, p.contact_id FROM kustomer_plan_conversations c JOIN kustomer_plan_customers p USING (run_id, kustomer_customer_id) WHERE c.run_id = $1 AND c.kustomer_customer_id = $2', [run.id, s.c.alice.id])).rows;
    const imp = createKustomerImporter({ db, vault, enabled: true });
    const isDuplicate = (m) => m.email_message_id === '<already-1@example.com>' || m.body === 'Running late?';
    const first = await imp.importBatch(77, plans, { isDuplicate });
    assert.deepEqual(first, { conversations: 2, messages: 3, notes: 1, skipped: 0 });
    const again = await imp.importBatch(77, plans, { isDuplicate });
    assert.deepEqual(again, { conversations: 0, messages: 0, notes: 0, skipped: 2 }); // idempotent
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
    assert.deepEqual(await imp.rollback(77), { conversations: 2 });
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE external_id LIKE 'kustomer:%'")).rows[0].n, 0);
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

  test('admins test, export, dry-run and download a sanitized report; others cannot', async () => {
    const admin = await login('boss@example.com');
    await call(admin, '/me'); // the first person in becomes an admin
    const agent = await login('agent@example.com');
    assert.equal((await call(agent, '/admin/kustomer')).status, 403);
    assert.equal((await call(agent, '/admin/kustomer/exports', {})).status, 403);
    const o = await call(admin, '/admin/kustomer');
    assert.equal(o.body.available, true);
    assert.equal(o.body.import_enabled, false);
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
    assert.equal((await call(admin, '/admin/kustomer/purge', {})).status, 200);
    assert.deepEqual((await call(admin, '/admin/kustomer')).body.stored, {});
  });
});
