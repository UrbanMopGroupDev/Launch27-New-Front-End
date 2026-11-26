import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { seed, RULES, UM } from '../src/inbox/seed.js';
import { addBusinessMinutes, isOpen } from '../src/inbox/hours.js';
import { normalizePhone, normalizeEmail, isStopWord } from '../src/inbox/normalize.js';
import { route, lintRules } from '../src/inbox/routing.js';
import * as svc from '../src/inbox/service.js';
import { createApp } from '../src/app.js';

const rules = RULES.map((r, i) => ({ ...r, id: i + 1, position: (i + 1) * 10 }));
const ctx = (over) => ({ channel: 'email', to: UM.info, from: 'jane@example.com', subject: '', body: '', roles: [], ...over });

describe('normalize', () => {
  test('phones become E.164', () => {
    assert.equal(normalizePhone('(613) 691-9880'), '+16136919880');
    assert.equal(normalizePhone('1-613-691-9880'), '+16136919880');
    assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
    assert.equal(normalizePhone('hello'), null);
  });
  test('emails are lower-cased and unwrapped', () => {
    assert.equal(normalizeEmail('Jane Doe <Jane@Example.COM>'), 'jane@example.com');
    assert.equal(normalizeEmail('not an email'), null);
  });
  test('STOP words', () => {
    assert.ok(isStopWord('STOP'));
    assert.ok(isStopWord('unsubscribe.'));
    assert.ok(!isStopWord("please don't stop coming"));
  });
});

describe('business hours (America/Toronto)', () => {
  test('a message at 7:55pm Saturday is due 9:05am Sunday with a 10-minute target', () => {
    const due = addBusinessMinutes(new Date('2026-11-07T19:55:00-05:00'), 10);
    assert.equal(due.toISOString(), new Date('2026-11-08T09:05:00-05:00').toISOString());
  });
  test('closed days are skipped', () => {
    const due = addBusinessMinutes(new Date('2026-12-24T19:50:00-05:00'), 20, { holidays: new Set(['2026-12-25']) });
    assert.equal(due.toISOString(), new Date('2026-12-26T08:10:00-05:00').toISOString());
  });
  test('daylight saving start keeps local opening time', () => {
    // DST starts Sunday Mar 14, 2027. Saturday 7:59pm EST + 2 min -> Sunday 9:01am EDT.
    const due = addBusinessMinutes(new Date('2027-03-13T19:59:00-05:00'), 2);
    assert.equal(due.toISOString(), new Date('2027-03-14T09:01:00-04:00').toISOString());
  });
  test('isOpen', () => {
    assert.ok(isOpen(new Date('2026-11-02T08:00:00-05:00')));
    assert.ok(!isOpen(new Date('2026-11-02T20:00:00-05:00')));
  });
});

describe('routing rules', () => {
  const q = (over) => route(rules, ctx(over)).action.queue;
  test('the audited cases land where Kustomer sent them', () => {
    assert.equal(q({}), 'operations');
    assert.equal(q({ to: UM.billing }), 'billing');
    assert.equal(q({ subject: 'Cart Abandonment: Jane' }), 'sales-overflow');
    assert.equal(q({ subject: 'Jane submitted an inquiry' }), 'sales');
    assert.equal(q({ channel: 'sms', to: UM.smsHiring, from: '+16135550100' }), 'hr');
    assert.equal(q({ channel: 'sms', to: UM.smsOttawa, from: '+16135550100' }), 'operations');
    assert.equal(q({ channel: 'sms', to: UM.smsOttawa, roles: ['cleaner'] }), 'operations');
    assert.equal(route(rules, ctx({ channel: 'sms', to: UM.smsOttawa, roles: ['cleaner'] })).action.sla, 'cleaner');
    assert.equal(q({ body: 'Leslie for review: refund' }), 'management');
    assert.equal(q({ lead_stage: undefined, leadStage: 'Attempt #2' }), 'sales');
    // Kustomer's Sales Queue Rule takes every chat (above its Operations - Chat Rule).
    assert.equal(q({ channel: 'chat', to: null }), 'sales');
  });
  test('system notices are marked done; bank codes are redacted', () => {
    assert.equal(route(rules, ctx({ from: 'notifications@kustomerapp.com' })).action.mark_done, true);
    const lb = route(rules, ctx({ subject: 'New booking request by Jane', body: 'Booking inserted into Launch 27?: Y' })).action;
    assert.equal(lb.mark_done, true);
    const notInserted = route(rules, ctx({ subject: 'New booking request by Jane', body: 'Booking inserted into Launch 27?: N' })).action;
    assert.equal(notInserted.queue, 'sales');
    assert.equal(route(rules, ctx({ body: 'Your RBCPayEdge Authentication Code is 123456' })).action.redact, true);
  });
  test('an unmatched message falls back', () => {
    assert.equal(route(rules, ctx({ channel: 'sms', to: '+15192860776' })).action.queue, 'fallback');
  });
  test('lint finds rules that can never match', () => {
    const warnings = lintRules([
      { id: 1, position: 1, name: 'Everything', conditions: {}, action: { queue: 'operations' } },
      { id: 2, position: 2, name: 'Billing', conditions: { to: [UM.billing] }, action: { queue: 'billing' } },
      { id: 3, position: 3, name: 'A', conditions: { channel: ['sms'] }, action: { queue: 'operations' } },
    ]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0].message, /never runs/);
    assert.deepEqual(lintRules(rules), []);
  });
});

describe('inbox service', () => {
  let db;
  let agent;
  let agent2;
  const t0 = new Date('2026-11-02T10:00:00-05:00'); // Monday 10am Toronto
  const at = (minutes) => new Date(t0.getTime() + minutes * 60_000);
  const conv = async (id) => (await db.query('SELECT * FROM conversations WHERE id = $1', [id])).rows[0];
  const ingest = (input, opts = {}) => db.tx((q) => svc.ingestInbound(q, input, { now: input.at ? new Date(input.at) : t0, ...opts }));

  before(async () => {
    db = await openDb();
    await seed(db);
    agent = (await db.query("INSERT INTO users (email, name, role, presence) VALUES ('alex@example.com','Alex Agent','agent','offline') RETURNING *")).rows[0];
    agent2 = (await db.query("INSERT INTO users (email, name, role, presence) VALUES ('sam@example.com','Sam Super','supervisor','offline') RETURNING *")).rows[0];
    await db.query("INSERT INTO queue_members (queue_id, user_id) SELECT id, $1 FROM queues WHERE slug IN ('operations','sales')", [agent.id]);
    await db.query("INSERT INTO queue_members (queue_id, user_id) SELECT id, $1 FROM queues WHERE slug = 'operations'", [agent2.id]);
  });
  after(() => db.close());

  test('a first text creates a contact and a routed conversation with an SLA', async () => {
    const r = await ingest({ channel: 'sms', from: '613-555-0101', to: UM.smsOttawa, body: 'Is my cleaner still coming?', external_id: 'tw:1', at: t0 });
    assert.ok(r.isNew);
    const c = await conv(r.conversationId);
    assert.equal(c.status, 'open');
    assert.equal(c.their_identity, '+16135550101');
    assert.equal(c.routed_by, 'Ottawa SMS to Operations');
    assert.equal(new Date(c.sla_due_at).toISOString(), at(240).toISOString());
    assert.equal(c.owner_id, null); // nobody available yet
  });

  test('a webhook delivered twice is stored once', async () => {
    const r = await ingest({ channel: 'sms', from: '613-555-0101', to: UM.smsOttawa, body: 'Is my cleaner still coming?', external_id: 'tw:1', at: t0 });
    assert.ok(r.duplicate);
    const n = (await db.query("SELECT count(*)::int AS n FROM messages WHERE external_id = 'tw:1'")).rows[0].n;
    assert.equal(n, 1);
  });

  test('going available picks up waiting work; a second text joins the same conversation', async () => {
    await db.tx((q) => svc.setPresence(q, agent, 'available'));
    const first = (await db.query("SELECT * FROM conversations WHERE their_identity = '+16135550101'")).rows[0];
    assert.equal(Number(first.owner_id), Number(agent.id));
    const r = await ingest({ channel: 'sms', from: '6135550101', to: UM.smsOttawa, body: 'Hello?', at: at(5) });
    assert.equal(r.conversationId, first.id);
    const notes = (await db.query("SELECT * FROM notifications WHERE user_id = $1 AND kind = 'reply'", [agent.id])).rows;
    assert.ok(notes.length >= 1);
  });

  test('replying stops the SLA clock; outbound is saved as not sent while channels are off', async () => {
    const c = (await db.query("SELECT * FROM conversations WHERE their_identity = '+16135550101'")).rows[0];
    const msg = await db.tx((q) => svc.reply(q, agent, c.id, { body: 'Yes, she is 10 minutes away.' }));
    assert.equal(msg.delivery_state, 'not_connected');
    assert.equal(msg.to_addr, '+16135550101');
    const after = await conv(c.id);
    assert.equal(after.sla_due_at, null);
    assert.ok(after.first_response_at);
  });

  test('done needs a disposition; a reply within 48 hours reopens, after that starts fresh', async () => {
    const c = (await db.query("SELECT * FROM conversations WHERE their_identity = '+16135550101'")).rows[0];
    await assert.rejects(db.tx((q) => svc.updateConversation(q, agent, c.id, { status: 'done' })), /Pick audience, reason, outcome/);
    await db.tx((q) => svc.updateConversation(q, agent, c.id, { status: 'done', disposition: { audience: 'Customer', reason: 'Cleaner arrival or late', outcome: 'Resolved' } }));
    const done = await conv(c.id);
    const r1 = await ingest({ channel: 'sms', from: '6135550101', to: UM.smsOttawa, body: 'Thanks!', at: new Date(new Date(done.done_at).getTime() + 3600_000) });
    assert.equal(r1.conversationId, c.id);
    assert.ok(r1.reopened);
    await db.tx((q) => svc.updateConversation(q, agent, c.id, { status: 'done' }));
    const later = new Date(Date.now() + 3 * 24 * 3600_000);
    const r2 = await ingest({ channel: 'sms', from: '6135550101', to: UM.smsOttawa, body: 'New question', at: later }, { now: later });
    assert.notEqual(r2.conversationId, c.id);
  });

  test('STOP blocks texts until START', async () => {
    const r = await ingest({ channel: 'sms', from: '613-555-0199', to: UM.smsOttawa, body: 'Hi', at: t0 });
    await ingest({ channel: 'sms', from: '613-555-0199', to: UM.smsOttawa, body: 'STOP', at: at(1) });
    await assert.rejects(db.tx((q) => svc.reply(q, agent, r.conversationId, { body: 'Hello' })), /replied STOP/);
    await ingest({ channel: 'sms', from: '613-555-0199', to: UM.smsOttawa, body: 'start', at: at(2) });
    const msg = await db.tx((q) => svc.reply(q, agent, r.conversationId, { body: 'Welcome back' }));
    assert.equal(msg.body, 'Welcome back');
  });

  test('a known cleaner (from the Launch27 lookup) is badged and gets the 5-minute target', async () => {
    const lookup = { name: 'Casey Cleaner', roles: ['cleaner'], l27_team_id: 4760, identities: [] };
    const r = await ingest({ channel: 'sms', from: '613-555-0177', to: UM.smsOttawa, body: 'Running 15 min late', at: t0 }, { lookup });
    const c = await conv(r.conversationId);
    assert.equal(c.routed_by, 'Cleaners to Operations');
    assert.equal(new Date(c.sla_due_at).toISOString(), at(5).toISOString());
    const contact = (await db.query('SELECT * FROM contacts WHERE id = $1', [c.contact_id])).rows[0];
    assert.deepEqual(contact.roles, ['cleaner']);
    assert.equal(Number(contact.l27_team_id), 4760);
  });

  test('email threads by thread key; an email is on one contact only, so it is never ambiguous', async () => {
    const a = await ingest({ channel: 'email', from: 'Pat <pat@example.com>', to: UM.billing, subject: 'Charge question', body: 'Why $200?', thread_key: 'gm:abc', at: t0 });
    const b = await ingest({ channel: 'email', from: 'pat@example.com', to: UM.billing, subject: 'Re: Charge question', body: 'Following up', thread_key: 'gm:abc', at: at(30) });
    assert.equal(a.conversationId, b.conversationId);
    assert.equal((await conv(a.conversationId)).routed_by, 'Billing & Financial Operations Queue');
    // A second contact can't take an email the first one has.
    const [samA, samB] = await db.tx(async (q) => [
      await svc.createContact(q, { name: 'Sam A', identities: [{ kind: 'email', value: 'family@example.com' }] }),
      await svc.createContact(q, { name: 'Sam B', identities: [{ kind: 'email', value: 'family@example.com' }] }),
    ]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM contact_identities WHERE contact_id = $1', [samB.id])).rows[0].n, 0);
    await assert.rejects(db.tx((q) => svc.addIdentity(q, samB.id, 'email', 'Family@Example.com')), (err) => err instanceof svc.IdentityTaken && Number(err.owner.id) === Number(samA.id));
    const s = await ingest({ channel: 'email', from: 'family@example.com', to: UM.info, subject: 'Hi', body: 'Booking?', at: t0 });
    const sc = await conv(s.conversationId);
    assert.equal(sc.needs_match, false);
    assert.equal(Number(sc.contact_id), Number(samA.id));
  });

  test('an unknown sender becomes a new contact; their next message (any channel) finds it', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n;
    const first = await ingest({ channel: 'sms', from: '613-555-0901', to: UM.smsOttawa, body: 'Hi, who do I talk to about a quote?', at: t0 });
    const c1 = await conv(first.conversationId);
    assert.ok(c1.contact_id);
    assert.equal(c1.needs_match, false);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n, before + 1);
    const call = await db.tx((q) => svc.logCall(q, agent, { call_id: 'u-1', direction: 'inbound', from: '(613) 555-0901', to: '613-691-9880', result: 'missed', started_at: t0.toISOString() }));
    assert.equal(Number((await conv(call.conversationId)).contact_id), Number(c1.contact_id));
    const out = await db.tx((q) => svc.logCall(q, agent, { call_id: 'u-2', direction: 'outbound', from: '613-691-9880', to: '+1 613 555 0901', result: 'answered', started_at: t0.toISOString() }));
    assert.equal(Number((await conv(out.conversationId)).contact_id), Number(c1.contact_id));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n, before + 1);
  });

  test('a new address for a Launch27 customer joins their contact; a deleted contact\'s thread is picked up again', async () => {
    const jane = await db.tx((q) => svc.createContact(q, { name: 'Jane L27', roles: ['customer'], l27_customer_id: 9077, identities: [{ kind: 'email', value: 'jane.l27@example.com' }] }));
    const lookup = { name: 'Jane L27', roles: ['customer'], l27_customer_id: 9077, identities: [{ kind: 'email', value: 'jane.l27@example.com' }, { kind: 'phone', value: '613-555-0977' }] };
    const r = await ingest({ channel: 'sms', from: '613-555-0977', to: UM.smsOttawa, body: 'Texting from my cell', at: t0 }, { lookup });
    assert.equal(Number((await conv(r.conversationId)).contact_id), Number(jane.id));
    await db.tx((q) => svc.deleteContact(q, agent, jane.id));
    assert.equal((await conv(r.conversationId)).contact_id, null);
    const again = await ingest({ channel: 'sms', from: '613-555-0977', to: UM.smsOttawa, body: 'Anyone there?', at: at(5) });
    assert.equal(again.conversationId, r.conversationId);
    const back = await conv(r.conversationId);
    assert.ok(back.contact_id);
    assert.notEqual(Number(back.contact_id), Number(jane.id));
  });

  test('two agents claiming at once: exactly one wins', async () => {
    await db.tx((q) => svc.setPresence(q, agent, 'busy'));
    const r = await ingest({ channel: 'email', from: 'race@example.com', to: UM.info, subject: 'Race', body: 'x', at: t0 });
    const results = await Promise.allSettled([db.tx((q) => svc.claim(q, agent, r.conversationId)), db.tx((q) => svc.claim(q, agent2, r.conversationId))]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.match(results.find((x) => x.status === 'rejected').reason.message, /already owns/);
  });

  test('going offline hands work back to the queue', async () => {
    await db.tx((q) => svc.setPresence(q, agent, 'available'));
    const r = await ingest({ channel: 'email', from: 'off@example.com', to: UM.info, subject: 'Off', body: 'x', at: t0 });
    assert.equal(Number((await conv(r.conversationId)).owner_id), Number(agent.id));
    const out = await db.tx((q) => svc.setPresence(q, agent, 'offline'));
    assert.ok(out.requeued >= 1);
    assert.equal((await conv(r.conversationId)).owner_id, null);
  });

  test('@mentions notify the person', async () => {
    const r = await ingest({ channel: 'email', from: 'mention@example.com', to: UM.info, subject: 'M', body: 'x', at: t0 });
    await db.tx((q) => svc.addNote(q, agent, r.conversationId, 'Can @sam call this customer back?'));
    const n = (await db.query("SELECT * FROM notifications WHERE user_id = $1 AND kind = 'mention'", [agent2.id])).rows;
    assert.equal(n.length, 1);
  });

  test('the worker warns, then marks a breach; snoozing pauses the clock', async () => {
    const r = await ingest({ channel: 'sms', from: '613-555-0166', to: UM.smsOttawa, body: 'hello', at: t0 }, { lookup: { name: 'Cleaner Two', roles: ['cleaner'], identities: [] } });
    const due = new Date((await conv(r.conversationId)).sla_due_at);
    const w = await db.tx((q) => svc.tick(q, new Date(due.getTime() - 30_000)));
    assert.ok(w.warned >= 1);
    const b = await db.tx((q) => svc.tick(q, new Date(due.getTime() + 1000)));
    assert.ok(b.breached >= 1);
    assert.ok((await conv(r.conversationId)).sla_breached_at);
  });

  test('missed calls create a callback target; answered calls belong to the agent', async () => {
    const missed = await db.tx((q) => svc.logCall(q, agent, { call_id: 'c1', direction: 'inbound', from: '613-555-0155', to: '613-691-9880', result: 'missed', started_at: t0.toISOString() }));
    const mc = await conv(missed.conversationId);
    assert.equal(mc.channel, 'voice');
    assert.equal(new Date(mc.sla_due_at).toISOString(), at(15).toISOString());
    const answered = await db.tx((q) => svc.logCall(q, agent, { call_id: 'c2', direction: 'inbound', from: '613-555-0144', to: '613-691-9880', result: 'answered', duration_seconds: 240, started_at: t0.toISOString() }));
    const ac = await conv(answered.conversationId);
    assert.equal(Number(ac.owner_id), Number(agent.id));
    assert.equal(ac.sla_due_at, null);
    const dup = await db.tx((q) => svc.logCall(q, agent, { call_id: 'c2', direction: 'inbound', from: '613-555-0144', to: '613-691-9880', result: 'answered' }));
    assert.ok(dup.duplicate);
  });
});

describe('/api end to end', () => {
  let db;
  let server;
  let base;
  let cookie;
  const config = { l27BaseUrl: 'https://l27.invalid', sessionSecret: 's', allowWrites: false, production: false, adminEmails: 'boss@urbanmop.ca' };
  // Fake Launch27: one login, one cleaner, one customer.
  const fetchImpl = async (url, _init = {}) => {
    if (url.endsWith('/latest/login')) return Response.json({ bearer: 'tok' });
    if (url.includes('/v1/staff/teams')) return Response.json(url.includes('offset=0') ? [{ id: 4760, title: 'Casey', first_name: 'Casey', last_name: 'C', phone: '613-555-0111' }] : []);
    if (url.includes('/v1/staff/customers/77/phones')) return Response.json([]);
    if (url.includes('/v1/staff/customers/77')) return Response.json({ id: 77, first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '613-555-0122' });
    if (url.includes('/v1/staff/customers')) return Response.json(url.includes('5550122') ? [{ id: 77, first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '613-555-0122' }] : []);
    return Response.json([]);
  };
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  before(async () => {
    db = await openDb();
    await seed(db);
    server = createApp(config, { fetchImpl, db }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boss@urbanmop.ca', password: 'x' }) });
    cookie = res.headers.get('set-cookie').split(';')[0];
  });
  after(async () => {
    server.close();
    await db.close();
  });

  test('brands: everyone reads the setup; admins map locations and people; bad brands are refused', async () => {
    const first = await api('/api/brands');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.brands.map((b) => b.slug), ['residential', 'commercial']);
    assert.deepEqual(first.body.overrides, {});
    assert.equal((await api('/api/brands/locations/42', { brand: 'commercial', name: 'Kingston' }, 'PUT')).status, 200);
    assert.equal((await api('/api/brands/locations/43', { brand: null, name: 'Test' }, 'PUT')).status, 200);
    assert.equal((await api('/api/brands/locations/44', { brand: 'luxury' }, 'PUT')).status, 400);
    const me = first.body.me.id;
    assert.equal((await api(`/api/brands/people/${me}`, { brand: 'residential' }, 'PUT')).status, 200);
    const after = (await api('/api/brands')).body;
    assert.deepEqual(after.overrides, { 42: 'commercial', 43: null });
    assert.equal(after.me.brand, 'residential');
    await api(`/api/brands/people/${me}`, { brand: null }, 'PUT');
    // A non-admin can read but not change.
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'agent2@urbanmop.ca', password: 'x' }) });
    const agent = login.headers.get('set-cookie').split(';')[0];
    const as = (path, body, method) => fetch(`${base}${path}`, { method, headers: { cookie: agent, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await as('/api/brands', null, 'GET')).status, 200);
    assert.equal((await as('/api/brands/locations/42', { brand: 'residential' }, 'PUT')).status, 403);
  });

  test('contacts: unlinked contacts are listed as leads, applicants, other, number only or flagged', async () => {
    const lead = (await api('/api/contacts', { name: 'Lee Lead', roles: [], phone: '613-555-0301' })).body;
    await api(`/api/contacts/${lead.id}`, { lead_stage: 'New', lead_source: 'Phone call' }, 'PATCH');
    const job = (await api('/api/contacts', { name: 'Ann Applicant', roles: ['applicant'], phone: '613-555-0302' })).body;
    const bare = (await api('/api/contacts', { roles: [], phone: '613-555-0303' })).body;
    const spam = (await api('/api/contacts', { roles: [], phone: '613-555-0304' })).body;
    assert.equal((await api(`/api/contacts/${spam.id}`, { caller_flag: 'spam' }, 'PATCH')).status, 200);
    assert.equal((await api(`/api/contacts/${spam.id}`, { caller_flag: 'nonsense' }, 'PATCH')).status, 400);
    const ids = async (list) => (await api(`/api/contact-list?list=${list}`)).body.rows.map((r) => Number(r.id));
    assert.ok((await ids('leads')).includes(Number(lead.id)));
    assert.ok((await ids('applicants')).includes(Number(job.id)));
    assert.ok((await ids('number_only')).includes(Number(bare.id)));
    assert.ok((await ids('flagged')).includes(Number(spam.id)));
    assert.ok(!(await ids('number_only')).includes(Number(spam.id)));
    const counts = (await api('/api/contact-list?list=leads')).body.counts;
    assert.ok(counts.leads >= 1 && counts.flagged >= 1);
  });

  test('contacts: every conversation of a contact, newest first, a page at a time', async () => {
    const who = (await api('/api/contacts', { name: 'Kim History', roles: ['customer'], email: 'kim.history@example.com' })).body;
    // Five closed conversations over the years; two share a time, so the id breaks the tie.
    const times = ['2019-01-01T10:00:00Z', '2021-06-01T10:00:00Z', '2021-06-01T10:00:00Z', '2023-03-03T10:00:00Z', '2025-05-05T10:00:00Z'];
    const ids = [];
    for (const t of times) ids.push(Number((await db.query("INSERT INTO conversations (contact_id, channel, status, subject, routed_by, last_message_at, created_at) VALUES ($1, 'email', 'done', 'Old', 'Imported from Kustomer', $2, $2) RETURNING id", [who.id, t])).rows[0].id));
    const seen = [];
    let next = null;
    let pages = 0;
    do {
      const page = await api(`/api/contacts/${who.id}/conversations?limit=2${next ? `&before=${encodeURIComponent(next)}` : ''}`);
      assert.equal(page.status, 200);
      seen.push(...page.body.rows.map((r) => Number(r.id)));
      next = page.body.next;
      pages++;
    } while (next && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(seen, [ids[4], ids[3], ids[2], ids[1], ids[0]]);
    assert.equal((await api('/api/contacts/abc/conversations')).status, 400);
  });

  test('calls: a hidden caller can be saved by name alone; nothing at all is refused', async () => {
    const made = await api('/api/contacts', { name: 'Hidden caller about a quote', roles: [] });
    assert.equal(made.status, 201);
    assert.equal(made.body.name, 'Hidden caller about a quote');
    assert.equal((await api('/api/contacts', { roles: [] })).status, 400);
  });

  test('calls: the last customer picked for a shared number is remembered', async () => {
    assert.deepEqual((await api('/api/caller-choice?phone=613-555-0199')).body, { l27_customer_id: null });
    assert.equal((await api('/api/caller-choice', { phone: '(613) 555-0199', l27_customer_id: 77 }, 'PUT')).status, 200);
    assert.deepEqual((await api('/api/caller-choice?phone=+16135550199')).body, { l27_customer_id: 77 });
    assert.equal((await api('/api/caller-choice', { phone: '613-555-0199', l27_customer_id: 'x' }, 'PUT')).status, 400);
  });

  test('requires login', async () => {
    assert.equal((await fetch(`${base}/api/me`)).status, 401);
  });

  test('simulated text from a Launch27 cleaner -> routed, badged, listed, replied to', async () => {
    const me = await api('/api/me');
    assert.equal(me.body.role, 'admin');
    await api('/api/me/presence', { presence: 'available' }, 'PUT');
    const sim = await api('/api/simulate/inbound', { channel: 'sms', from: '613-555-0111', to: UM.smsOttawa, body: 'Locked out at 12 Elm St' });
    assert.equal(sim.status, 201);
    const list = await api('/api/conversations?view=mine');
    assert.equal(list.body.length, 1);
    assert.deepEqual(list.body[0].contact_roles, ['cleaner']);
    const detail = await api(`/api/conversations/${sim.body.conversationId}`);
    assert.equal(detail.body.contact.name, 'Casey C');
    assert.equal(detail.body.messages.filter((m) => m.kind === 'message').length, 1);
    const sent = await api(`/api/conversations/${sim.body.conversationId}/messages`, { body: 'Calling the customer now' });
    assert.equal(sent.body.delivery_state, 'not_connected');
    const done = await api(`/api/conversations/${sim.body.conversationId}`, { status: 'done', disposition: { audience: 'Cleaner', reason: 'Other', outcome: 'Resolved' } }, 'PATCH');
    assert.equal(done.body.status, 'done');
  });

  test('opening a Launch27 customer creates one contact and links later messages', async () => {
    const a = await api('/api/contacts/from-l27', { customer_id: 77 });
    const b = await api('/api/contacts/from-l27', { customer_id: 77 });
    assert.equal(a.body.id, b.body.id);
    const sim = await api('/api/simulate/inbound', { channel: 'sms', from: '6135550122', to: UM.smsOttawa, body: 'Can we move Thursday?' });
    const detail = await api(`/api/conversations/${sim.body.conversationId}`);
    assert.equal(detail.body.contact.id, a.body.id);
    const search = await api('/api/search?q=Thursday');
    assert.equal(search.body.conversations[0].id, sim.body.conversationId);
  });

  test('rules: lint, dry run and supervisor view', async () => {
    const rules = await api('/api/admin/rules');
    assert.equal(rules.body.rules.length, RULES.length);
    assert.deepEqual(rules.body.warnings, []);
    const dry = await api('/api/admin/rules/test', { channel: 'email', to: UM.billing, from: 'x@y.com', subject: 'Invoice' });
    assert.equal(dry.body.rule, 'Billing & Financial Operations Queue');
    const sup = await api('/api/supervisor');
    assert.equal(sup.status, 200);
    assert.ok(sup.body.queues.find((q) => q.slug === 'operations').open >= 1);
  });

  test('settings: every team member can change routing; access control stays with admins', async () => {
    await api('/api/me');
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alex.agent@urbanmop.ca', password: 'x' }) });
    const agentCookie = login.headers.get('set-cookie').split(';')[0];
    const as = async (path, body, method = body ? 'POST' : 'GET') => {
      const res = await fetch(`${base}${path}`, { method, headers: { cookie: agentCookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    };
    const me = await as('/api/me');
    assert.equal(me.body.role, 'agent');

    // Routing rules, reply targets, queues, policies and saved replies: open to agents.
    const { rules } = (await as('/api/admin/rules')).body;
    const edited = rules.map((r, i) => (i === 0 ? { ...r, enabled: false } : r));
    const saved = await as('/api/admin/rules', { rules: [...edited, { name: 'Agent rule', enabled: true, conditions: { subject_contains: ['gift card'] }, action: { queue: 'sales' } }] }, 'PUT');
    assert.equal(saved.status, 200);
    assert.equal(saved.body.rules.at(-1).name, 'Agent rule');
    const sla = (await as('/api/meta')).body.sla_policies[0];
    assert.equal((await as(`/api/admin/sla/${sla.id}`, { first_response_minutes: 20, warn_minutes: 5 }, 'PUT')).status, 200);
    assert.equal((await as(`/api/admin/sla/${sla.id}`, { first_response_minutes: 20, warn_minutes: 30 }, 'PUT')).status, 400);
    const ops = (await as('/api/admin/workforce')).body.queues.find((q) => q.slug === 'operations');
    assert.equal((await as(`/api/admin/queues/${ops.id}`, { routing_mode: 'round_robin' }, 'PATCH')).status, 200);
    assert.equal((await as('/api/admin/settings', { assign_on_reply: false }, 'PUT')).status, 200);
    assert.equal((await as('/api/admin/canned', { shortcut: 'hi', title: 'Hello', body: 'Hi {{first_name}}' }, 'PUT')).status, 200);
    assert.equal((await as(`/api/users/${me.body.id}`, { capacity: { sms: 4 } }, 'PATCH')).status, 200);

    // Who can see private queues stays with admins.
    assert.equal((await as(`/api/users/${me.body.id}`, { role: 'admin' }, 'PATCH')).status, 403);
    assert.equal((await as(`/api/users/${me.body.id}`, { team_ids: [1] }, 'PATCH')).status, 403);
    assert.equal((await as(`/api/admin/queues/${ops.id}`, { restricted: true }, 'PATCH')).status, 403);
    assert.equal((await as('/api/admin/teams', { teams: [] }, 'PUT')).status, 403);
    assert.equal((await as('/api/admin/settings', { settings_editors: 'everyone' }, 'PUT')).status, 403);

    // Everyone sees who changed what.
    const history = await as('/api/admin/history');
    const ruleChange = history.body.find((h) => h.action === 'rules.replaced');
    assert.deepEqual(ruleChange.detail.added, ['Agent rule']);
    assert.deepEqual(ruleChange.detail.changed, [rules[0].name]);
    assert.deepEqual(ruleChange.detail.removed, []);
    assert.equal(ruleChange.detail.reordered, false);
    assert.equal(ruleChange.actor_email, 'alex.agent@urbanmop.ca');

    // An admin can narrow it down to admins only.
    assert.equal((await api('/api/admin/settings', { settings_editors: 'admins' }, 'PUT')).status, 200);
    assert.equal((await as('/api/admin/rules', { rules }, 'PUT')).status, 403);
    assert.equal((await api('/api/admin/rules', { rules }, 'PUT')).status, 200);
    await api('/api/admin/settings', { settings_editors: 'everyone' }, 'PUT');
  });
  test('calls log: lists calls; a missed call is open until it is called back', async () => {
    const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
    await api('/api/calls', { call_id: 'log-1', direction: 'inbound', from: '613-555-0411', to: '613-691-9880', result: 'missed', started_at: at(30) });
    await api('/api/calls', { call_id: 'log-2', direction: 'inbound', from: '613-555-0412', to: '613-691-9880', result: 'missed', started_at: at(20) });
    await api('/api/calls', { call_id: 'log-3', direction: 'outbound', from: '613-691-9880', to: '613-555-0412', result: 'no_answer', started_at: at(10) });
    await api('/api/calls', { call_id: 'log-4', direction: 'inbound', from: '613-555-0413', to: '613-691-9880', result: 'missed', started_at: at(9) });
    await api('/api/calls', { call_id: 'log-5', direction: 'outbound', from: '613-691-9880', to: '613-555-0413', result: 'answered', duration_seconds: 95, started_at: at(5) });
    const log = await api('/api/calls?days=1');
    assert.equal(log.status, 200);
    const missedFrom = (n) => log.body.rows.find((r) => r.direction === 'in' && r.from_addr.endsWith(n));
    assert.equal(missedFrom('5550411').callback, 'open');
    assert.equal(missedFrom('5550412').callback, 'tried');
    assert.equal(missedFrom('5550413').callback, 'called_back');
    const out = log.body.rows.find((r) => r.direction === 'out' && r.to_addr.endsWith('5550413'));
    assert.equal(out.result, 'answered');
    assert.equal(out.duration_seconds, 95);
    assert.ok(out.agent_name);
  });

  test('calls: a hidden number is accepted but not logged (nothing to call back)', async () => {
    const res = await api('/api/calls', { call_id: 'hid-1', direction: 'inbound', from: 'Anonymous', to: '613-691-9880', result: 'missed' });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { saved: false, hidden: true });
  });

  test('calls: test calls from the simulator are saved (missed calls get a callback conversation)', async () => {
    const res = await api('/api/calls', { call_id: 'sim-1', simulated: true, direction: 'inbound', from: '613-555-0177', to: '613-691-9880', result: 'missed', started_at: new Date().toISOString() });
    assert.equal(res.status, 201);
    assert.ok(res.body.conversationId);
  });

  test('contacts: adding someone already here reuses them; details on two contacts are refused', async () => {
    const robin = await api('/api/contacts', { name: 'Robin Lead', roles: [], phone: '613-555-0701', lead_stage: 'New', notes: 'Kanata, 3 bed' });
    assert.equal(robin.status, 201);
    assert.equal(robin.body.existing, false);
    assert.equal(robin.body.lead_stage, 'New');
    const again = await api('/api/contacts', { name: 'Robin Again', roles: [], phone: '(613) 555-0701', email: 'Robin@Example.com' });
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.id, robin.body.id);
    assert.equal(again.body.name, 'Robin Lead', 'an existing name is kept');
    assert.deepEqual(again.body.identities.map((i) => i.value).sort(), ['+16135550701', 'robin@example.com']);
    const other = await api('/api/contacts', { name: 'Other Person', roles: [], email: 'other.person@example.com' });
    assert.equal(other.status, 201);
    const both = await api('/api/contacts', { name: 'Mixed', roles: [], phone: '613-555-0701', email: 'other.person@example.com' });
    assert.equal(both.status, 409);
    assert.deepEqual(both.body.contacts.map((c) => c.id).sort(), [Number(robin.body.id), Number(other.body.id)].sort());
    assert.equal((await api('/api/contacts', { name: 'Bad', roles: [], phone: '123' })).status, 400);
    assert.equal((await api('/api/contacts', { name: 'Bad', roles: [], email: 'not-an-email' })).status, 400);
    assert.equal((await api('/api/contacts', { name: 'Bad', roles: ['boss'] })).status, 400);
    // "Who is this?" is gone from the inbox counts.
    assert.ok(!('needs_match' in (await api('/api/counts')).body));
  });

  test('contacts: every detail can be edited; an email on another contact is refused, then merged', async () => {
    const c = (await api('/api/contacts', { name: 'Edit Me', roles: [], phone: '613-555-0711', email: 'edit.me@example.com' })).body;
    const named = await api(`/api/contacts/${c.id}`, { name: '  Edited Name ', notes: 'Back door', lead_stage: 'New', communication_preference: 'Text' }, 'PATCH');
    assert.equal(named.status, 200);
    assert.equal(named.body.name, 'Edited Name');
    assert.equal(named.body.notes, 'Back door');
    const phone = c.identities.find((i) => i.kind === 'phone');
    const email = c.identities.find((i) => i.kind === 'email');
    const moved = await api(`/api/identities/${phone.id}`, { value: '613-555-0712', label: 'Cell' }, 'PATCH');
    assert.equal(moved.status, 200);
    assert.equal(moved.body.value, '+16135550712');
    assert.equal(moved.body.label, 'Cell');
    assert.equal((await api(`/api/identities/${phone.id}`, { value: 'nope' }, 'PATCH')).status, 400);
    const other = (await api('/api/contacts', { name: 'Taken Person', roles: ['applicant'], email: 'taken@example.com' })).body;
    const clash = await api(`/api/identities/${email.id}`, { value: 'TAKEN@example.com' }, 'PATCH');
    assert.equal(clash.status, 409);
    assert.equal(clash.body.contact.id, Number(other.id));
    assert.match(clash.body.error, /already on Taken Person/);
    assert.equal((await api(`/api/contacts/${c.id}/identities`, { kind: 'email', value: 'taken@example.com' })).status, 409);
    const merged = await api(`/api/contacts/${c.id}/merge`, { contact_id: other.id });
    assert.equal(merged.status, 200);
    assert.deepEqual(merged.body.roles, ['applicant']);
    assert.ok(merged.body.identities.some((i) => i.value === 'taken@example.com'));
    assert.equal((await api(`/api/contacts/${other.id}`)).status, 404);
    assert.equal((await api(`/api/contacts/${c.id}/merge`, { contact_id: c.id })).status, 400);
    assert.equal((await api(`/api/identities/${email.id}`, null, 'DELETE')).status, 200);
    const after = (await api(`/api/contacts/${c.id}`)).body;
    assert.deepEqual(after.identities.map((i) => i.value).sort(), ['+16135550712', 'taken@example.com']);
    // The old number is free again for someone else.
    assert.equal((await api('/api/contacts', { name: 'New Owner', roles: [], phone: '613-555-0711' })).status, 201);
  });

  test('contacts: an email taken off a Launch27 customer stays off; linking a lead to that customer merges them', async () => {
    const jane = (await api('/api/contacts/from-l27', { customer_id: 77 })).body;
    const full = (await api(`/api/contacts/${jane.id}`)).body;
    const email = full.identities.find((i) => i.value === 'jane@example.com');
    assert.ok(email, 'Launch27 email on the contact');
    assert.equal((await api(`/api/identities/${email.id}`, null, 'DELETE')).status, 200);
    await api('/api/contacts/from-l27', { customer_id: 77 }); // refresh from Launch27
    assert.ok(!(await api(`/api/contacts/${jane.id}`)).body.identities.some((i) => i.value === 'jane@example.com'));
    // Linking a lead to a customer who already has a contact: one contact, the customer's.
    const lead = (await api('/api/contacts', { name: 'Jane as a lead', roles: [], email: 'jane.lead@example.com', lead_stage: 'New' })).body;
    const linked = await api(`/api/contacts/${lead.id}`, { l27_customer_id: 77, roles: ['customer'], lead_stage: 'Booked' }, 'PATCH');
    assert.equal(linked.status, 200);
    assert.equal(linked.body.merged_into, Number(jane.id));
    assert.equal(linked.body.lead_stage, 'Booked');
    assert.equal((await api(`/api/contacts/${lead.id}`)).status, 404);
    assert.ok((await api(`/api/contacts/${jane.id}`)).body.identities.some((i) => i.value === 'jane.lead@example.com'));
    assert.equal((await api('/api/contacts/from-l27', { customer_id: 77 })).body.id, jane.id);
  });

  test('contacts: deleting one keeps their conversations and a STOP on their number', async () => {
    const sim = (await api('/api/simulate/inbound', { channel: 'sms', from: '613-555-0721', to: UM.smsOttawa, body: 'Hi there' })).body;
    await api('/api/simulate/inbound', { channel: 'sms', from: '613-555-0721', to: UM.smsOttawa, body: 'STOP' });
    const cid = (await api(`/api/conversations/${sim.conversationId}`)).body.contact.id;
    const del = await api(`/api/contacts/${cid}`, null, 'DELETE');
    assert.equal(del.status, 200);
    assert.equal(del.body.conversations, 1);
    assert.equal((await api(`/api/contacts/${cid}`)).status, 404);
    const detail = (await api(`/api/conversations/${sim.conversationId}`)).body;
    assert.equal(detail.contact, null);
    assert.ok(detail.messages.some((m) => m.meta?.type === 'contact_deleted'));
    assert.equal((await api(`/api/conversations/${sim.conversationId}/messages`, { body: 'Hello?' })).status, 409, 'still opted out');
    const back = await api('/api/contacts', { name: 'Back Again', roles: [], phone: '613-555-0721' });
    assert.equal(back.status, 201);
    assert.equal(back.body.identities[0].opted_out, true);
    // "Save as a contact" on the conversation puts it back on a contact.
    assert.equal((await api(`/api/conversations/${sim.conversationId}`, { contact_id: 999999 }, 'PATCH')).status, 404);
    assert.equal((await api(`/api/conversations/${sim.conversationId}`, { contact_id: back.body.id }, 'PATCH')).status, 200);
    assert.equal((await api(`/api/conversations/${sim.conversationId}`)).body.contact.id, back.body.id);
    assert.equal((await api('/api/contacts/999999', null, 'DELETE')).status, 404);
    assert.equal((await api('/api/contacts/abc', null, 'DELETE')).status, 404);
    const audit = (await api(`/api/audit?object_type=contact&object_id=${cid}`)).body;
    assert.ok(audit.some((a) => a.action === 'contact.deleted' && a.detail.identities[0].value === '+16135550721'));
  });

  test('contacts: All lists everyone (Launch27 customers too) and searches names, numbers and emails', async () => {
    const ids = async (q) => (await api(`/api/contact-list?list=all&q=${encodeURIComponent(q)}`)).body.rows.map((r) => Number(r.id));
    const back = (await api('/api/contacts', { name: 'Back Again', roles: [], phone: '613-555-0721' })).body;
    assert.ok((await ids('back again')).includes(Number(back.id)));
    assert.ok((await ids('555-0721')).includes(Number(back.id)));
    assert.ok((await ids('6135550721')).includes(Number(back.id)));
    const jane = (await api('/api/contacts/from-l27', { customer_id: 77 })).body;
    assert.ok((await ids('jane.lead@')).includes(Number(jane.id)));
    assert.ok(!(await ids('jane.lead@')).includes(Number(back.id)));
    const all = (await api('/api/contact-list?list=all')).body;
    assert.ok(all.rows.some((r) => Number(r.id) === Number(jane.id)));
    assert.ok(all.counts.all >= all.counts.leads + all.counts.applicants);
  });
});
