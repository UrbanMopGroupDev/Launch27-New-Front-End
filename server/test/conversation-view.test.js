// The conversation view and work list brought over from the BookingKoala front end: list sort
// and time range, agent-started conversations that only count once something is written, the
// whole-person timeline, Select → mark done, suggested people, and email files downloaded
// from Gmail (read-only: nothing is ever sent).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { seed, UM } from '../src/inbox/seed.js';
import * as svc from '../src/inbox/service.js';
import { createApp } from '../src/app.js';
import { guardConnectors } from '../src/inbox/channels.js';
import { attachmentParts } from '../src/inbox/email/mime.js';
import { createGmailConnector } from '../src/inbox/email/gmail.js';

const fakeL27 = async (url) => (String(url).endsWith('/latest/login') ? Response.json({ bearer: 'tok' }) : Response.json([]));
const TWILIO = '+16135557002'; // the only number the SMS connector here can send from
const login = async (base, email) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'x' }) })).headers.get('set-cookie').split(';')[0];
const client = (base, cookie) => async (path, body, method = body ? 'POST' : 'GET') => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

// Gmail stand-in: one received email with two files.
const GMAIL_MESSAGE = {
  id: 'gm-1',
  payload: {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: Buffer.from('See attached').toString('base64url') } },
      { mimeType: 'application/pdf', filename: 'quote.pdf', body: { attachmentId: 'att-pdf', size: 5 } },
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: Buffer.from('inline!').toString('base64url'), size: 7 } },
    ],
  },
};
const fakeGmailClient = () => ({
  message: async (account, id) => {
    if (id !== 'gm-1') throw Object.assign(new Error('Gmail 404'), { status: 404 });
    return GMAIL_MESSAGE;
  },
  attachment: async (account, id, attachmentId) => ({ data: Buffer.from(attachmentId === 'att-pdf' ? '%PDF!' : '').toString('base64url') }),
});

describe('conversation view: work list, drafts, whole history, bulk done', () => {
  let db;
  let server;
  let base;
  let api;
  let agentApi;
  const t0 = Date.now();
  const ingest = (input) => db.tx((q) => svc.ingestInbound(q, input, { now: new Date(input.at) }));
  const sent = [];

  before(async () => {
    db = await openDb();
    await seed(db);
    const sms = { name: 'twilio', identities: [TWILIO], send: async (m) => (sent.push(m), { id: `sm${sent.length}`, state: 'queued' }) };
    server = createApp({ l27BaseUrl: 'https://l27.invalid', sessionSecret: 's', production: false, adminEmails: 'boss@urbanmop.ca' }, { db, fetchImpl: fakeL27, connectors: { sms } }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    api = client(base, await login(base, 'boss@urbanmop.ca'));
    await api('/api/me'); // the first person in becomes an admin
    agentApi = client(base, await login(base, 'agent@urbanmop.ca'));
    await agentApi('/api/me');
  });
  after(async () => {
    server.close();
    await db.close();
  });

  test('the list sorts newest, oldest or by reply deadline, and narrows to a time range', async () => {
    const old = await ingest({ channel: 'sms', from: '613-555-0401', to: UM.smsOttawa, body: 'Two weeks ago', at: new Date(t0 - 14 * 86_400_000) });
    const mid = await ingest({ channel: 'sms', from: '613-555-0402', to: UM.smsOttawa, body: 'Yesterday', at: new Date(t0 - 86_400_000) });
    const fresh = await ingest({ channel: 'sms', from: '613-555-0403', to: UM.smsOttawa, body: 'Just now', at: new Date(t0 - 60_000) });
    const ids = async (q) => (await api(`/api/conversations?view=all${q}`)).body.map((c) => Number(c.id)).filter((id) => [old, mid, fresh].some((x) => Number(x.conversationId) === id));
    const [o, m, f] = [old, mid, fresh].map((x) => Number(x.conversationId));
    assert.deepEqual(await ids(''), [f, m, o]); // newest first by default
    assert.deepEqual(await ids('&sort=oldest'), [o, m, f]);
    assert.equal((await ids('&sort=due')).length, 3);
    assert.deepEqual(await ids('&sort=nonsense'), [f, m, o]); // unknown sort: the default, never raw SQL
    assert.deepEqual(await ids(`&since=${encodeURIComponent(new Date(t0 - 2 * 86_400_000).toISOString())}`), [f, m]);
    assert.deepEqual(await ids('&since=not-a-date'), [f, m, o]);
  });

  test('a conversation an agent started counts only once something is written; sending clears the draft', async () => {
    const contact = (await api('/api/contacts', { name: 'Drew Draft', roles: ['customer'], phone: '613-555-0410' })).body;
    const conv = (await api('/api/conversations', { contact_id: contact.id, channel: 'sms' })).body;
    assert.equal(conv.routed_by, 'Started by agent');
    assert.equal(conv.our_identity, TWILIO); // from a number Twilio can send from, not the old RingCentral line
    const listed = async () => (await api('/api/conversations?view=all')).body.some((c) => Number(c.id) === Number(conv.id));
    const counted = async () => (await api('/api/counts')).body.mine;
    const before = await counted();
    assert.equal(await listed(), false); // empty: not work yet
    assert.equal((await api(`/api/conversations/${conv.id}/draft`, { text: 'Hi Drew, about Thursday' }, 'PUT')).status, 200);
    assert.equal(await listed(), true);
    assert.equal(await counted(), before + 1);
    assert.equal((await api(`/api/conversations/${conv.id}`)).body.conversation.draft, 'Hi Drew, about Thursday');
    await api(`/api/conversations/${conv.id}/draft`, { text: '   ' }, 'PUT'); // blank clears it
    assert.equal(await listed(), false);
    await api(`/api/conversations/${conv.id}/draft`, { text: 'Hi Drew' }, 'PUT');
    const reply = await api(`/api/conversations/${conv.id}/messages`, { body: 'Hi Drew', idempotency_key: 'draft-1' });
    assert.equal(reply.status, 201);
    const after = (await db.query('SELECT draft, draft_at FROM conversations WHERE id = $1', [conv.id])).rows[0];
    assert.deepEqual([after.draft, after.draft_at], [null, null]);
    assert.equal(await listed(), true); // now it has a message
    // The contact page lists it too, only now.
    assert.ok((await api(`/api/contacts/${contact.id}`)).body.conversations.some((c) => Number(c.id) === Number(conv.id)));
  });

  test('a person\'s whole history spans their conversations, oldest first', async () => {
    const a = await ingest({ channel: 'sms', from: '613-555-0420', to: UM.smsOttawa, body: 'Text first', at: new Date(t0 - 3 * 3_600_000) });
    const contactId = (await db.query('SELECT contact_id FROM conversations WHERE id = $1', [a.conversationId])).rows[0].contact_id;
    await db.query("INSERT INTO contact_identities (contact_id, kind, value) VALUES ($1, 'email', 'whole@example.com')", [contactId]);
    const b = await ingest({ channel: 'email', from: 'whole@example.com', to: UM.info, subject: 'A question', body: 'Then an email', at: new Date(t0 - 3_600_000) });
    assert.notEqual(Number(a.conversationId), Number(b.conversationId));
    const h = (await api(`/api/conversations/${a.conversationId}/history`)).body;
    assert.equal(h.conversations, 2);
    const bodies = h.messages.filter((m) => m.kind === 'message').map((m) => m.body);
    assert.deepEqual(bodies, ['Text first', 'Then an email']);
    assert.ok(h.messages.every((m) => m.conversation_id && m.conversation_channel));
    // No contact: just this conversation.
    const lone = (await db.query("INSERT INTO conversations (channel, their_identity) VALUES ('sms', '+16135550499') RETURNING id")).rows[0];
    assert.deepEqual((await api(`/api/conversations/${lone.id}/history`)).body, { messages: [], conversations: 1 });
    // A restricted queue's conversation stays out of an agent's view of the history.
    const restricted = (await db.query("INSERT INTO queues (slug, name, restricted) VALUES ('vip', 'VIP', true) RETURNING id")).rows[0];
    await db.query('UPDATE conversations SET queue_id = $2 WHERE id = $1', [b.conversationId, restricted.id]);
    await db.query('UPDATE conversations SET queue_id = NULL, owner_id = NULL WHERE id = $1', [a.conversationId]);
    const seen = (await agentApi(`/api/conversations/${a.conversationId}/history`)).body;
    assert.equal(seen.conversations, 1);
    assert.ok(!seen.messages.some((m) => m.body === 'Then an email'));
  });

  test('Select → Mark done closes several with one reason, and says which could not be closed', async () => {
    const one = await ingest({ channel: 'sms', from: '613-555-0430', to: UM.smsOttawa, body: 'One', at: new Date(t0) });
    const two = await ingest({ channel: 'sms', from: '613-555-0431', to: UM.smsOttawa, body: 'Two', at: new Date(t0) });
    const disposition = { audience: 'Customer', reason: 'Cleaner arrival or late', outcome: 'Resolved' };
    const res = await api('/api/conversations/bulk/done', { ids: [one.conversationId, two.conversationId, 999999], disposition });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.done.sort(), [Number(one.conversationId), Number(two.conversationId)].sort());
    assert.deepEqual(res.body.failed, [{ id: 999999, error: 'Conversation not found' }]);
    const rows = (await db.query('SELECT status, disposition FROM conversations WHERE id = ANY($1::bigint[])', [[one.conversationId, two.conversationId]])).rows;
    assert.ok(rows.every((r) => r.status === 'done' && r.disposition.outcome === 'Resolved'));
    // Already done counts as done; nothing picked, or too many, is refused.
    assert.deepEqual((await api('/api/conversations/bulk/done', { ids: [one.conversationId], disposition })).body.done, [Number(one.conversationId)]);
    assert.equal((await api('/api/conversations/bulk/done', { ids: [] })).status, 400);
    assert.equal((await api('/api/conversations/bulk/done', { ids: Array.from({ length: 201 }, (_, i) => i + 1) })).status, 400);
  });

  test('New conversation suggests people this agent was last in touch with', async () => {
    const r = await ingest({ channel: 'sms', from: '613-555-0440', to: UM.smsOttawa, body: 'Hello there', at: new Date(t0) });
    await api(`/api/conversations/${r.conversationId}/messages`, { body: 'Hi!', idempotency_key: 'sugg-1' });
    const { recent, frequent } = (await api('/api/contacts/suggested')).body;
    const contactId = (await db.query('SELECT contact_id FROM conversations WHERE id = $1', [r.conversationId])).rows[0].contact_id;
    assert.equal(Number(recent[0].id), Number(contactId));
    assert.equal(recent[0].last_channel, 'sms');
    assert.ok(recent[0].identities.some((i) => i.value === '+16135550440'));
    assert.ok(Array.isArray(frequent));
    // Someone else's replies are not "recent" for this agent.
    assert.ok(!(await agentApi('/api/contacts/suggested')).body.recent.some((c) => Number(c.id) === Number(contactId)));
  });
});

describe('email files: downloaded from Gmail on request, never sent', () => {
  let db;
  let server;
  let base;
  let api;
  let message;
  const sends = [];

  before(async () => {
    db = await openDb();
    await seed(db);
    const email = createGmailConnector({ client: { ...fakeGmailClient(), send: async () => sends.push(1) }, mailboxes: { sendAs: new Map([[UM.info, UM.info]]) } });
    server = createApp({ l27BaseUrl: 'https://l27.invalid', sessionSecret: 's', production: true, notificationsMode: 'live', adminEmails: 'boss@urbanmop.ca' }, { db, fetchImpl: fakeL27, connectors: { email } }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    api = client(base, await login(base, 'boss@urbanmop.ca'));
    await api('/api/me');
    const r = await db.tx((q) => svc.ingestInbound(q, { channel: 'email', from: 'files@example.com', to: UM.info, subject: 'Quote', body: 'See attached', meta: { gmail_id: 'gm-1', mailbox: UM.info, attachments: [{ filename: 'quote.pdf', size: 5 }, { filename: 'notes.txt', size: 7 }] } }));
    message = (await db.query("SELECT id FROM messages WHERE conversation_id = $1 AND kind = 'message'", [r.conversationId])).rows[0];
    // The ingest may not keep meta as given; set it the way the Gmail sync stores it.
    await db.query("UPDATE messages SET meta = $2::jsonb, channel = 'email' WHERE id = $1", [message.id, JSON.stringify({ gmail_id: 'gm-1', mailbox: UM.info, attachments: [{ filename: 'quote.pdf', size: 5 }, { filename: 'notes.txt', size: 7 }] })]);
  });
  after(async () => {
    server.close();
    await db.close();
  });

  test('a file is fetched from the mailbox and handed over as a download', async () => {
    const pdf = await api(`/api/messages/${message.id}/attachments/0`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.body.toString(), '%PDF!');
    assert.equal(pdf.headers.get('content-type'), 'application/octet-stream');
    assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="quote.pdf"/);
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    const txt = await api(`/api/messages/${message.id}/attachments/1`);
    assert.equal(txt.body.toString(), 'inline!'); // small files sit in the message itself
    assert.equal(sends.length, 0);
  });

  test('missing, changed or test-only files are refused clearly', async () => {
    assert.equal((await api(`/api/messages/${message.id}/attachments/5`)).status, 404);
    assert.equal((await api(`/api/messages/${message.id}/attachments/x`)).status, 404);
    await db.query("UPDATE messages SET meta = jsonb_set(meta, '{attachments,0,filename}', '\"other.pdf\"') WHERE id = $1", [message.id]);
    const changed = await api(`/api/messages/${message.id}/attachments/0`);
    assert.equal(changed.status, 409);
    assert.match(changed.body.error, /changed in Gmail/);
    await db.query("UPDATE messages SET meta = meta - 'gmail_id' WHERE id = $1", [message.id]);
    assert.match((await api(`/api/messages/${message.id}/attachments/1`)).body.error, /test message/);
  });

  test('read-only email keeps file downloads in production, and never sends', async () => {
    const live = { email: { name: 'gmail', identities: [UM.info], send: async () => ({ id: 'x' }), attachment: async () => ({}) } };
    const guarded = guardConnectors(live, 'live');
    assert.equal(typeof guarded.email.attachment, 'function');
    await assert.rejects(guarded.email.send({}), /read-only/i);
    assert.equal(guardConnectors(live, 'sandbox').email.attachment, undefined); // dev and QA read no real mailbox
  });

  test('the files on a Gmail message are found in the order the inbox lists them', () => {
    assert.deepEqual(attachmentParts(GMAIL_MESSAGE).map((p) => [p.filename, p.attachmentId]), [['quote.pdf', 'att-pdf'], ['notes.txt', null]]);
  });
});
