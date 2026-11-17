// Live SMS through RingCentral, against a fake RingCentral (HTTP level) and a fake Launch27.
// Nothing here reaches RingCentral or sends a text.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { seed, UM } from '../src/inbox/seed.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { guardConnectors } from '../src/inbox/channels.js';
import { createL27Client } from '../src/inbox/lookup.js';
import { createRingCentralClient, deliveryState } from '../src/inbox/sms/ringcentral.js';
import { createSmsChannel } from '../src/inbox/sms/service.js';

const RC = 'https://platform.ringcentral.test';
const OTTAWA = UM.smsOttawa; // +16136919880
const HIRING = UM.smsHiring; // +16136918368
const NOT_SMS = '+16135550000'; // on the extension, voice only
const JANE = '+16135550122'; // Launch27 customer 77
const CASEY = '+16135550111'; // Launch27 cleaner 4760
const SHARED = '+16135550199'; // two Launch27 customers
const TOKEN = 'webhook-verification-token-123456';

/** A fake RingCentral: token endpoint, extension, numbers, SMS, Message Store, subscriptions. */
function fakeRingCentral() {
  const s = {
    tokenFails: false,
    scope: 'SMS ReadMessages ReadAccounts WebhookSubscriptions',
    revoked: new Set(),
    tokens: 0,
    sends: [],
    sendPlan: [], // per call: 'ok' | 429 | 500
    statuses: new Map(),
    store: [], // inbound message-store records
    subs: new Map(),
    subCalls: [],
    nextId: 1000,
  };
  const json = (body, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  s.fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/restapi/oauth/token') {
      assert.equal(init.headers.authorization, `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
      const p = new URLSearchParams(init.body);
      assert.equal(p.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.equal(p.get('assertion'), 'jwt-credential');
      if (s.tokenFails) return json({ error: 'invalid_grant', error_description: 'JWT token is expired' }, 400);
      s.tokens++;
      return json({ access_token: `tok${s.tokens}`, expires_in: 3600, scope: s.scope });
    }
    const auth = init.headers?.authorization || '';
    if (!/^Bearer tok\d+$/.test(auth) || s.revoked.has(auth.slice(7))) return json({ errorCode: 'TokenInvalid', message: 'Token not found' }, 401);
    const path = u.pathname.replace('/restapi/v1.0', '');
    const method = init.method || 'GET';
    if (path === '/account/~/extension/~') return json({ id: 111, extensionNumber: '101', name: 'Support', account: { id: 999 } });
    if (path === '/account/~/extension/~/phone-number') return json({ records: [{ phoneNumber: OTTAWA, features: ['SmsSender', 'CallerId'] }, { phoneNumber: HIRING, features: ['SmsSender'] }, { phoneNumber: NOT_SMS, features: ['CallerId'] }], navigation: {} });
    if (path === '/account/~/extension/~/sms' && method === 'POST') {
      const plan = s.sendPlan.shift() || 'ok';
      if (plan === 429) return json({ errorCode: 'CMN-301', message: 'Request rate exceeded' }, 429, { 'retry-after': '2' });
      if (plan === 500) return json({ message: 'Internal error' }, 500);
      const body = JSON.parse(init.body);
      const id = String(s.nextId++);
      s.sends.push({ id, ...body });
      s.statuses.set(id, 'Queued');
      return json({ id, messageStatus: 'Queued', direction: 'Outbound', type: 'SMS' });
    }
    const one = /^\/account\/~\/extension\/~\/message-store\/(.+)$/.exec(path);
    if (one) return s.statuses.has(one[1]) ? json({ id: one[1], messageStatus: s.statuses.get(one[1]) }) : json({ message: 'Not found' }, 404);
    if (path === '/account/~/extension/~/message-store') {
      const from = u.searchParams.get('dateFrom');
      return json({ records: s.store.filter((m) => m.creationTime >= from), navigation: {} });
    }
    if (path === '/subscription' && method === 'POST') {
      const body = JSON.parse(init.body);
      s.subCalls.push({ op: 'create', body });
      const id = `sub${s.subs.size + 1}-${s.subCalls.length}`;
      s.subs.set(id, { id, status: 'Active', expirationTime: new Date(Date.now() + 7 * 864e5).toISOString() });
      return json(s.subs.get(id));
    }
    const sub = /^\/subscription\/([^/]+)(\/renew)?$/.exec(path);
    if (sub) {
      const cur = s.subs.get(sub[1]);
      if (!cur) return json({ message: 'Subscription not found' }, 404);
      if (method === 'DELETE') {
        s.subs.delete(sub[1]);
        s.subCalls.push({ op: 'delete', id: sub[1] });
        return json(null, 204);
      }
      if (sub[2]) {
        cur.expirationTime = new Date(Date.now() + 7 * 864e5).toISOString();
        s.subCalls.push({ op: 'renew', id: sub[1] });
      }
      return json(cur);
    }
    throw new Error(`fake RingCentral: unhandled ${method} ${path}`);
  };
  return s;
}

// Launch27: Jane (customer 77), Casey (cleaner 4760), two customers on one number.
const l27Fetch = async (url) => {
  if (url.endsWith('/latest/login')) return Response.json({ bearer: 'tok' });
  if (url.includes('/v1/staff/teams')) return Response.json(url.includes('offset=0') ? [{ id: 4760, title: 'Casey', first_name: 'Casey', last_name: 'C', phone: '613-555-0111' }] : []);
  if (url.includes('/v1/staff/customers')) {
    if (url.includes('5550122')) return Response.json([{ id: 77, first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '613-555-0122' }]);
    if (url.includes('5550199')) return Response.json([{ id: 81, first_name: 'Pat', last_name: 'A', phone: '613-555-0199' }, { id: 82, first_name: 'Sam', last_name: 'A', phone: '613-555-0199' }]);
    return Response.json([]);
  }
  return Response.json([]);
};

let seq = 0;
const inbound = (from, to, text, id = `in${++seq}`) => ({ id, from: { phoneNumber: from }, to: [{ phoneNumber: to }], type: 'SMS', direction: 'Inbound', subject: text, creationTime: new Date().toISOString(), conversation: { id: `c-${id}` } });
const notification = (m, subscriptionId) => ({ uuid: `uuid-${Math.random()}`, event: '/restapi/v1.0/account/999/extension/111/message-store/instant?type=SMS', subscriptionId, timestamp: new Date().toISOString(), body: m });

describe('RingCentral SMS', () => {
  let db;
  let rc;
  let sms;
  let server;
  let base;
  let admin;
  let agent;
  let identifyFails = 0;
  const config = { l27BaseUrl: 'https://l27.invalid', sessionSecret: 's', production: true, notificationsMode: 'live', adminEmails: 'boss@urbanmop.ca' };
  const login = async (email) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'x' }) })).headers.get('set-cookie').split(';')[0];
  const api = async (cookie, path, body, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const hook = (body, headers = {}) => fetch(`${base}/webhooks/ringcentral/sms`, { method: 'POST', headers: { 'content-type': 'application/json', 'verification-token': TOKEN, ...headers }, body: JSON.stringify(body) });
  const subscriptionId = async () => (await db.query("SELECT subscription_id FROM sms_provider_state WHERE provider = 'ringcentral'")).rows[0]?.subscription_id;
  const convFor = async (their, ours) => (await db.query('SELECT c.*, q.slug AS queue, co.l27_customer_id, co.l27_team_id FROM conversations c LEFT JOIN queues q ON q.id = c.queue_id LEFT JOIN contacts co ON co.id = c.contact_id WHERE c.their_identity = $1 AND c.our_identity = $2 ORDER BY c.id DESC LIMIT 1', [their, ours])).rows[0];

  before(async () => {
    db = await openDb();
    await seed(db);
    rc = fakeRingCentral();
    const client = createRingCentralClient({ server: RC, clientId: 'cid', clientSecret: 'csecret', jwt: 'jwt-credential', fetchImpl: rc.fetchImpl, sleep: async () => {} });
    const l27 = createL27Client({ baseUrl: config.l27BaseUrl, fetchImpl: l27Fetch });
    sms = createSmsChannel({
      db,
      client,
      smsConfig: { numbers: [OTTAWA, HIRING, NOT_SMS], webhookUrl: 'https://app.example.com/webhooks/ringcentral/sms', webhookToken: TOKEN },
      identify: async (phone) => {
        if (identifyFails > 0) {
          identifyFails--;
          throw new Error('Launch27 timed out');
        }
        return l27.match('tok', 'phone', phone);
      },
    });
    await sms.start();
    server = createApp(config, { db, fetchImpl: l27Fetch, connectors: { sms: sms.connector }, sms }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    admin = await login('boss@urbanmop.ca');
    await api(admin, '/api/me'); // first in becomes admin
    await api(admin, '/api/me/presence', { presence: 'available' }, 'PUT');
    agent = await login('agent@urbanmop.ca');
    await api(agent, '/api/me');
  });
  after(async () => {
    server.close();
    await db.close();
  });

  test('health: signs in with the JWT, finds the extension and which numbers can text', async () => {
    const ch = (await api(admin, '/api/channels')).body.sms;
    assert.equal(ch.state, 'live');
    assert.equal(ch.provider, 'ringcentral');
    const r = ch.ringcentral;
    assert.equal(r.health_ok, true);
    assert.deepEqual(r.health.extension, { id: '111', number: '101', name: 'Support' });
    assert.deepEqual(r.health.sms_numbers, [OTTAWA, HIRING]);
    assert.deepEqual(r.health.not_sms_capable, [NOT_SMS]);
    assert.deepEqual(r.health.missing_scopes, []);
    // Each number shows the queue its texts go to, from the routing rules.
    assert.deepEqual(r.numbers.map((n) => [n.number, n.can_send, n.queue]), [[OTTAWA, true, 'Operations'], [HIRING, true, 'Hiring'], [NOT_SMS, false, 'Fallback']]);
    // The webhook subscription was created for the SMS event, with our verification token.
    assert.equal(r.has_subscription, true);
    const create = rc.subCalls.find((c) => c.op === 'create');
    assert.deepEqual(create.body.eventFilters, ['/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS']);
    assert.equal(create.body.deliveryMode.verificationToken, TOKEN);
    assert.equal(create.body.deliveryMode.address, 'https://app.example.com/webhooks/ringcentral/sms');
    // No secret ever appears in the status.
    assert.ok(!JSON.stringify(ch).includes('csecret') && !JSON.stringify(ch).includes('jwt-credential') && !JSON.stringify(ch).includes(TOKEN));
    const meta = (await api(admin, '/api/meta')).body;
    assert.deepEqual(meta.identities.sms, [OTTAWA, HIRING, NOT_SMS]);
  });

  test('webhook: answers RingCentral\'s validation request and refuses anyone without the token', async () => {
    const v = await fetch(`${base}/webhooks/ringcentral/sms`, { method: 'POST', headers: { 'validation-token': 'abc123', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(v.status, 200);
    assert.equal(v.headers.get('validation-token'), 'abc123');
    assert.equal((await hook(notification(inbound(JANE, OTTAWA, 'x')), { 'verification-token': 'wrong' })).status, 403);
    const none = await fetch(`${base}/webhooks/ringcentral/sms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(none.status, 403);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM sms_events')).rows[0].n, 0);
  });

  test('inbound: a customer\'s text lands in the inbox, matched, routed and on their story', async () => {
    const m = inbound(JANE, OTTAWA, 'Is my cleaner still coming today?');
    const res = await hook(notification(m, await subscriptionId()));
    assert.equal(res.status, 200);
    await sms.processEvents();
    const c = await convFor(JANE, OTTAWA);
    assert.ok(c, 'conversation created');
    assert.equal(c.channel, 'sms');
    assert.equal(c.queue, 'operations');
    assert.equal(Number(c.l27_customer_id), 77);
    assert.equal(c.needs_match, false);
    assert.equal(Number(c.owner_id) > 0, true); // assigned to the available agent
    assert.ok(c.sla_due_at, 'reply target set');
    const msg = (await db.query("SELECT * FROM messages WHERE conversation_id = $1 AND kind = 'message'", [c.id])).rows[0];
    assert.equal(msg.body, 'Is my cleaner still coming today?');
    assert.equal(msg.external_id, `ringcentral:sms:111:${m.id}`);
    // Customer page (contact for Launch27 customer 77) lists it.
    const contact = await api(admin, '/api/contacts/from-l27', { customer_id: 77 });
    const full = await api(admin, `/api/contacts/${contact.body.id}`);
    assert.ok(full.body.conversations.some((x) => x.id === c.id && x.channel === 'sms'));
    // The stored event keeps no message text once processed.
    const ev = (await db.query('SELECT status, payload FROM sms_events ORDER BY id DESC LIMIT 1')).rows[0];
    assert.equal(ev.status, 'done');
    assert.equal(ev.payload, null);
    const st = (await api(admin, '/api/channels')).body.sms.ringcentral;
    assert.ok(st.last_webhook_at && st.last_received_at);
  });

  test('duplicate webhook events and the Message Store check never store a text twice', async () => {
    const m = inbound(JANE, OTTAWA, 'Running 5 min late, door code is 1234');
    const sid = await subscriptionId();
    await hook(notification(m, sid));
    await hook(notification(m, sid)); // RingCentral retried with a new uuid
    rc.store.push(m); // and it's in the Message Store too
    await sms.processEvents();
    await sms.reconcile();
    await sms.processEvents();
    const n = (await db.query("SELECT count(*)::int AS n FROM messages WHERE body = 'Running 5 min late, door code is 1234'")).rows[0].n;
    assert.equal(n, 1);
  });

  test('a cleaner texting the hiring number goes to Hiring, as the cleaner, in its own conversation', async () => {
    await hook(notification(inbound(CASEY, HIRING, 'Can I pick up more shifts?'), await subscriptionId()));
    await hook(notification(inbound(CASEY, OTTAWA, 'Locked out at 12 Elm St'), await subscriptionId()));
    await sms.processEvents();
    const hiring = await convFor(CASEY, HIRING);
    const ops = await convFor(CASEY, OTTAWA);
    assert.equal(hiring.queue, 'hiring');
    assert.equal(Number(hiring.l27_team_id), 4760);
    assert.equal(ops.queue, 'operations');
    assert.notEqual(hiring.id, ops.id); // one conversation per business number, never merged
  });

  test('unknown senders and numbers shared by two customers go to "Who is this?"', async () => {
    await hook(notification(inbound('+16135550404', OTTAWA, 'Hi, do you clean offices?'), await subscriptionId()));
    await hook(notification(inbound(SHARED, OTTAWA, 'Need to reschedule'), await subscriptionId()));
    await sms.processEvents();
    const unknown = await convFor('+16135550404', OTTAWA);
    const shared = await convFor(SHARED, OTTAWA);
    assert.equal(unknown.needs_match, true);
    assert.equal(shared.needs_match, true);
    assert.equal(shared.l27_customer_id, null); // not guessed
    const ev = (await db.query("SELECT body, meta FROM messages WHERE conversation_id = $1 AND kind = 'event' AND meta->>'type' = 'needs_match'", [shared.id])).rows[0];
    assert.deepEqual(ev.meta.l27_candidates, [81, 82]);
    const list = await api(admin, '/api/conversations?view=needs_match');
    assert.ok(list.body.some((c) => c.id === unknown.id) && list.body.some((c) => c.id === shared.id));
    // Linking the unknown contact to Launch27 takes it out of "Who is this?".
    await api(admin, `/api/contacts/${unknown.contact_id}`, { l27_customer_id: 90, roles: ['customer'] }, 'PATCH');
    assert.equal((await convFor('+16135550404', OTTAWA)).needs_match, false);
  });

  let janeConv;
  test('agent replies go out through RingCentral from the conversation\'s number; status is tracked', async () => {
    janeConv = await convFor(JANE, OTTAWA);
    const before = rc.sends.length;
    const sent = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'Yes! She is 10 minutes away.', idempotency_key: 'k-1' });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.delivery_state, 'queued'); // accepted by RingCentral, not yet delivered
    const out = rc.sends.at(-1);
    assert.equal(rc.sends.length, before + 1);
    assert.deepEqual(out.from, { phoneNumber: OTTAWA });
    assert.deepEqual(out.to, [{ phoneNumber: JANE }]);
    assert.equal(out.text, 'Yes! She is 10 minutes away.');
    assert.equal(sent.body.external_id, `ringcentral:${out.id}`);
    // Delivery status from RingCentral.
    rc.statuses.set(out.id, 'Delivered');
    await sms.updateDeliveries();
    const row = (await db.query('SELECT delivery_state FROM messages WHERE id = $1', [sent.body.id])).rows[0];
    assert.equal(row.delivery_state, 'delivered');
    assert.equal(deliveryState('SendingFailed'), 'failed');
  });

  test('the same send repeated (double click, retry) texts the customer once', async () => {
    const before = rc.sends.length;
    const a = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'See you at 2', idempotency_key: 'k-2' });
    const b = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'See you at 2', idempotency_key: 'k-2' });
    const [c, d] = await Promise.all([1, 2].map(() => api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'Parallel', idempotency_key: 'k-3' })));
    assert.equal(a.body.id, b.body.id);
    assert.equal(c.body.id, d.body.id);
    assert.equal(rc.sends.length - before, 2);
  });

  test('rate limits are retried; RingCentral errors and numbers that cannot text fail clearly, never "sent"', async () => {
    rc.sendPlan.push(429);
    const retried = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'After a rate limit', idempotency_key: 'k-4' });
    assert.equal(retried.body.delivery_state, 'queued');
    const before = rc.sends.length;
    rc.sendPlan.push(500);
    const failed = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'During an outage', idempotency_key: 'k-5' });
    assert.equal(failed.status, 201);
    assert.equal(failed.body.delivery_state, 'failed');
    assert.match(failed.body.meta.note, /may or may not have been sent/);
    assert.equal(rc.sends.length, before); // a send that may have reached RingCentral is never retried
    const wrongFrom = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'From a voice line', from: NOT_SMS, idempotency_key: 'k-6' });
    assert.equal(wrongFrom.body.delivery_state, 'failed');
    assert.match(wrongFrom.body.meta.note, /can't send texts/);
    assert.equal(rc.sends.length, before);
  });

  test('STOP blocks texts until START', async () => {
    await hook(notification(inbound(JANE, OTTAWA, 'STOP'), await subscriptionId()));
    await sms.processEvents();
    const blocked = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'Hello?' });
    assert.equal(blocked.status, 409);
    await hook(notification(inbound(JANE, OTTAWA, 'START'), await subscriptionId()));
    await sms.processEvents();
    assert.equal((await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'Welcome back', idempotency_key: 'k-7' })).body.delivery_state, 'queued');
  });

  test('an incoming text that fails to process is retried later, then lands', async () => {
    identifyFails = 1;
    await hook(notification(inbound('+16135550777', OTTAWA, 'Hello from a new number'), await subscriptionId()));
    await sms.processEvents();
    let ev = (await db.query("SELECT * FROM sms_events ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(ev.status, 'pending');
    assert.equal(ev.attempts, 1);
    assert.match(ev.last_error, /timed out/);
    assert.ok(new Date(ev.next_attempt_at) > new Date());
    await db.query('UPDATE sms_events SET next_attempt_at = now() WHERE id = $1', [ev.id]);
    await sms.processEvents();
    ev = (await db.query('SELECT * FROM sms_events WHERE id = $1', [ev.id])).rows[0];
    assert.equal(ev.status, 'done');
    assert.ok(await convFor('+16135550777', OTTAWA));
  });

  test('webhook downtime: the Message Store check picks up texts the webhook never delivered', async () => {
    const missed = [inbound(JANE, HIRING, 'Missed one'), inbound('+16135550888', OTTAWA, 'Missed two')];
    rc.store.push(...missed);
    assert.equal(await sms.reconcile(), 2);
    await sms.processEvents();
    assert.ok(await convFor(JANE, HIRING));
    assert.ok(await convFor('+16135550888', OTTAWA));
    assert.equal(await sms.reconcile(), 0); // already seen
  });

  test('subscriptions are renewed before they expire and recreated when lost or suspended', async () => {
    const id = await subscriptionId();
    rc.subs.get(id).expirationTime = new Date(Date.now() + 3600_000).toISOString();
    await sms.ensureSubscription();
    assert.equal(rc.subCalls.at(-1).op, 'renew');
    rc.subs.get(id).status = 'Suspended';
    await sms.ensureSubscription();
    assert.ok(rc.subCalls.slice(-2).map((c) => c.op).join() === 'delete,create');
    const replaced = await subscriptionId();
    assert.notEqual(replaced, id);
    rc.subs.delete(replaced); // removed on RingCentral's side
    await sms.ensureSubscription();
    assert.notEqual(await subscriptionId(), replaced);
    // Events from an old subscription are ignored.
    await hook(notification(inbound(JANE, OTTAWA, 'From an old subscription'), 'sub-old'));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM sms_events WHERE payload->>'subject' = 'From an old subscription'")).rows[0].n, 0);
  });

  test('expired credentials: health shows the problem, sends fail clearly, recovery is automatic', async () => {
    rc.tokenFails = true;
    await sms.check();
    let st = (await api(admin, '/api/channels')).body.sms.ringcentral;
    assert.match(st.last_error, /JWT token is expired/);
    rc.revoked.add(`tok${rc.tokens}`); // the current access token stops working too
    const failed = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'While signed out', idempotency_key: 'k-8' });
    assert.equal(failed.body.delivery_state, 'failed');
    assert.match(failed.body.meta.note, /sign-in failed/);
    rc.tokenFails = false;
    await sms.check();
    st = (await api(admin, '/api/channels')).body.sms.ringcentral;
    assert.equal(st.health_ok, true);
    assert.equal((await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'Signed in again', idempotency_key: 'k-9' })).body.delivery_state, 'queued');
  });

  test('missing permissions on the RingCentral app stop sending until fixed', async () => {
    rc.scope = 'ReadMessages ReadAccounts';
    rc.revoked.add(`tok${rc.tokens}`);
    await sms.check();
    const st = (await api(admin, '/api/channels')).body.sms.ringcentral;
    assert.equal(st.health_ok, false);
    assert.deepEqual(st.health.missing_scopes, ['SMS', 'WebhookSubscriptions']);
    assert.equal((await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'x', idempotency_key: 'k-10' })).body.delivery_state, 'failed');
    rc.scope = 'SMS ReadMessages ReadAccounts SubscriptionWebhook'; // older name of the same permission
    rc.revoked.add(`tok${rc.tokens}`);
    await sms.check();
    assert.equal((await api(admin, '/api/channels')).body.sms.ringcentral.health_ok, true);
  });

  test('admins disconnect and reconnect; agents cannot', async () => {
    assert.equal((await api(agent, '/api/admin/sms/disconnect', {})).status, 403);
    const off = await api(admin, '/api/admin/sms/disconnect', {});
    assert.equal(off.body.sms.ringcentral.enabled, false);
    assert.equal(off.body.sms.ringcentral.has_subscription, false);
    const sent = await api(admin, `/api/conversations/${janeConv.id}/messages`, { body: 'While disconnected', idempotency_key: 'k-11' });
    assert.equal(sent.body.delivery_state, 'failed');
    assert.match(sent.body.meta.note, /disconnected/);
    rc.store.push(inbound(JANE, OTTAWA, 'Sent while disconnected'));
    const on = await api(admin, '/api/admin/sms/connect', {});
    assert.equal(on.body.sms.ringcentral.enabled, true);
    assert.equal(on.body.sms.ringcentral.has_subscription, true);
    // Reconnecting catches up on what arrived meanwhile.
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE body = 'Sent while disconnected'")).rows[0].n, 1);
    const audit = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'sms.%' ORDER BY id")).rows.map((r) => r.action);
    assert.deepEqual(audit.slice(-2), ['sms.disconnect', 'sms.connect']);
  });
});

describe('SMS in development and QA', () => {
  test('sends are sandbox records: RingCentral is never called', async () => {
    const rc = fakeRingCentral();
    const db = await openDb();
    const client = createRingCentralClient({ server: RC, clientId: 'cid', clientSecret: 'csecret', jwt: 'jwt-credential', fetchImpl: rc.fetchImpl, sleep: async () => {} });
    const sms = createSmsChannel({ db, client, smsConfig: { numbers: [OTTAWA] } });
    const guarded = guardConnectors({ sms: sms.connector }, 'sandbox');
    assert.equal(guarded.sms.sandbox, true);
    await guarded.sms.send({ channel: 'sms', from: OTTAWA, to: JANE, body: 'hi' });
    assert.equal(rc.sends.length, 0);
    assert.equal(rc.tokens, 0);
    await db.close();
  });

  test('production credentials only work in production; dev and QA only take the RingCentral sandbox', () => {
    const creds = { RINGCENTRAL_SMS_CLIENT_ID: 'a', RINGCENTRAL_SMS_CLIENT_SECRET: 'b', RINGCENTRAL_SMS_JWT: 'c' };
    const qaProd = loadConfig({ ...creds, APP_ENV: 'staging', RINGCENTRAL_SMS_SERVER: 'https://platform.ringcentral.com' });
    assert.equal(qaProd.ringcentralSms, null);
    assert.ok(qaProd.warnings.some((w) => /only the RingCentral sandbox/.test(w)));
    const qaSandbox = loadConfig({ ...creds, APP_ENV: 'staging' });
    assert.equal(qaSandbox.ringcentralSms.server, 'https://platform.devtest.ringcentral.com');
    assert.equal(qaSandbox.notificationsMode, 'sandbox'); // its sends are recorded, not sent
    const prodSandbox = loadConfig({ ...creds, APP_ENV: 'production', RINGCENTRAL_SMS_SERVER: 'https://platform.devtest.ringcentral.com' });
    assert.equal(prodSandbox.ringcentralSms, null);
    const prod = loadConfig({ ...creds, APP_ENV: 'production', RINGCENTRAL_SMS_NUMBERS: `${OTTAWA}, ${HIRING}`, RINGCENTRAL_SMS_WEBHOOK_URL: 'https://app.example.com/webhooks/ringcentral/sms', RINGCENTRAL_SMS_WEBHOOK_TOKEN: TOKEN });
    assert.equal(prod.ringcentralSms.server, 'https://platform.ringcentral.com');
    assert.deepEqual(prod.ringcentralSms.numbers, [OTTAWA, HIRING]);
    assert.equal(loadConfig({ ...creds, APP_ENV: 'production', RINGCENTRAL_SMS_WEBHOOK_URL: 'http://insecure.example.com' }).ringcentralSms, null);
    assert.equal(loadConfig({ ...creds, APP_ENV: 'production', RINGCENTRAL_SMS_WEBHOOK_URL: 'https://a.example.com', RINGCENTRAL_SMS_WEBHOOK_TOKEN: 'short' }).ringcentralSms, null);
    assert.equal(loadConfig({ APP_ENV: 'production', RINGCENTRAL_SMS_JWT: 'c' }).ringcentralSms, null); // incomplete
    // The calling widget's settings are untouched.
    assert.equal(loadConfig({ APP_ENV: 'production', RINGCENTRAL_CLIENT_ID: 'w', RINGCENTRAL_SERVER: 'https://platform.ringcentral.com' }).ringcentralClientId, 'w');
  });
});
