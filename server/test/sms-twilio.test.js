// Twilio SMS (the only SMS provider), against a fake Twilio (HTTP level) and a fake Launch27.
// Nothing here reaches Twilio or sends a text.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { seed, UM } from '../src/inbox/seed.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { guardConnectors } from '../src/inbox/channels.js';
import { createL27Client } from '../src/inbox/lookup.js';
import { createTwilioClient, twilioSignature, twilioState } from '../src/inbox/sms/twilio.js';
import { createTwilioChannel } from '../src/inbox/sms/twilio-channel.js';
import { createSmsRouter } from '../src/inbox/sms/core.js';

// Made up, and deliberately not shaped like a real Account SID (so secret scanning stays quiet).
const SID = 'AC_test_account_not_real';
const AUTH = 'twilio-auth-token-secret';
const BASE = 'https://app.example.com';
const NOT_OURS = '+16135557999'; // not one of our Twilio numbers
const SHARED = '+16135550199'; // on two Launch27 customers
const HIRING = UM.smsHiring; // Twilio
const T2 = '+16135557002'; // Twilio, incoming texts still pointed elsewhere (e.g. Kustomer)
const T3 = '+16135557003'; // Twilio, voice only
const JANE = '+16135550122';
const CASEY = '+16135550111';

function fakeTwilio() {
  const s = { accountStatus: 'active', sends: [], sendPlan: [], statuses: new Map(), inbox: [], seq: 1, gets: 0, updates: [] };
  s.numbers = [
    { sid: 'PN_hiring', phone_number: HIRING, capabilities: { sms: true, voice: true }, sms_url: `${BASE}/webhooks/twilio/sms`, sms_method: 'POST', sms_application_sid: '' },
    { sid: 'PN_t2', phone_number: T2, capabilities: { sms: true }, sms_url: 'https://kustomer.example/twilio', sms_method: 'POST', sms_application_sid: '' },
    { sid: 'PN_t3', phone_number: T3, capabilities: { sms: false, voice: true }, sms_url: '', sms_method: 'POST', sms_application_sid: '' },
  ];
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  s.fetchImpl = async (url, init = {}) => {
    assert.equal(init.headers.authorization, `Basic ${Buffer.from(`${SID}:${AUTH}`).toString('base64')}`);
    const u = new URL(url);
    const root = `/2010-04-01/Accounts/${SID}`;
    const method = init.method || 'GET';
    if (method === 'GET') s.gets++;
    if (u.pathname === `${root}.json`) return json({ sid: SID, status: s.accountStatus, friendly_name: 'UrbanMop', type: 'Full' });
    if (u.pathname === `${root}/IncomingPhoneNumbers.json`)
      return json({ incoming_phone_numbers: s.numbers.map((n) => ({ ...n })), next_page_uri: null });
    const num = new RegExp(`^${root}/IncomingPhoneNumbers/(PN\\w+)\\.json$`).exec(u.pathname);
    if (num && method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      const n = s.numbers.find((x) => x.sid === num[1]);
      s.updates.push({ sid: num[1], ...form });
      if ('SmsUrl' in form) n.sms_url = form.SmsUrl;
      if ('SmsMethod' in form) n.sms_method = form.SmsMethod;
      if ('SmsApplicationSid' in form) n.sms_application_sid = form.SmsApplicationSid;
      return json({ ...n });
    }
    if (u.pathname === `${root}/Messages.json` && method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      const plan = s.sendPlan.shift() || 'ok';
      if (plan === 429) return json({ code: 20429, message: 'Too Many Requests' }, 429, { 'retry-after': '1' });
      if (plan === 500) return json({ code: 20500, message: 'Internal Server Error' }, 500);
      if (plan === 21610) return json({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }, 400);
      const sid = `SM${String(s.seq++).padStart(32, '0')}`;
      s.sends.push({ sid, ...form });
      s.statuses.set(sid, 'queued');
      return json({ sid, status: 'queued', direction: 'outbound-api' }, 201);
    }
    if (u.pathname === `${root}/Messages.json`) {
      const to = u.searchParams.get('To');
      const day = u.searchParams.get('DateSent>');
      assert.ok(day, 'filters by date');
      return json({ messages: s.inbox.filter((m) => m.to === to), next_page_uri: null });
    }
    const one = new RegExp(`^${root}/Messages/(SM\\w+)\\.json$`).exec(u.pathname);
    if (one) return s.statuses.has(one[1]) ? json({ sid: one[1], status: s.statuses.get(one[1]), error_code: s.statuses.get(one[1]) === 'undelivered' ? 30003 : null }) : json({ code: 20404, message: 'Not found' }, 404);
    throw new Error(`fake Twilio: unhandled ${method} ${u.pathname}`);
  };
  return s;
}

const l27Fetch = async (url) => {
  if (url.endsWith('/latest/login')) return Response.json({ bearer: 'tok' });
  if (url.includes('/v1/staff/teams')) return Response.json(url.includes('offset=0') ? [{ id: 4760, title: 'Casey', first_name: 'Casey', last_name: 'C', phone: '613-555-0111' }] : []);
  if (url.includes('/v1/staff/customers')) {
    if (url.includes('5550122')) return Response.json([{ id: 77, first_name: 'Jane', last_name: 'Doe', phone: '613-555-0122' }]);
    if (url.includes('5550199')) return Response.json([{ id: 81, first_name: 'Ann', last_name: 'A', phone: '613-555-0199' }, { id: 82, first_name: 'Ben', last_name: 'B', phone: '613-555-0199' }]);
  }
  return Response.json([]);
};

let seq = 0;
const incoming = (from, to, body, extra = {}) => ({ MessageSid: `SMin${String(++seq).padStart(28, '0')}`, AccountSid: SID, From: from, To: to, Body: body, NumMedia: '0', ...extra });

describe('Twilio SMS', () => {
  let db;
  let tw;
  let twilio;
  let identifyFails = 0;
  let server;
  let base;
  let admin;
  const config = { l27BaseUrl: 'https://l27.invalid', sessionSecret: 's', production: true, notificationsMode: 'live', adminEmails: 'boss@urbanmop.ca' };
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie: admin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  // Post the way Twilio does: form-encoded and signed for the public URL.
  const twilioPost = (path, params, { signature } = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature ?? twilioSignature(AUTH, `${BASE}${path}`, params) }, body: new URLSearchParams(params).toString() });
  const convFor = async (their, ours) => (await db.query('SELECT c.*, q.slug AS queue, co.l27_customer_id, co.l27_team_id FROM conversations c LEFT JOIN queues q ON q.id = c.queue_id LEFT JOIN contacts co ON co.id = c.contact_id WHERE c.their_identity = $1 AND c.our_identity = $2 ORDER BY c.id DESC LIMIT 1', [their, ours])).rows[0];
  const twilioDetail = async () => (await api('/api/channels')).body.sms.providers.find((p) => p.provider === 'twilio');

  before(async () => {
    db = await openDb();
    await seed(db);
    tw = fakeTwilio();
    const l27 = createL27Client({ baseUrl: config.l27BaseUrl, fetchImpl: l27Fetch });
    twilio = createTwilioChannel({
      db,
      client: createTwilioClient({ accountSid: SID, authToken: AUTH, fetchImpl: tw.fetchImpl, sleep: async () => {} }),
      smsConfig: { numbers: [HIRING, T2, T3], webhookBaseUrl: BASE, authToken: AUTH },
      identify: async (phone) => {
        if (identifyFails > 0) {
          identifyFails--;
          throw new Error('Launch27 timed out');
        }
        return l27.match('tok', 'phone', phone);
      },
    });
    await twilio.start();
    const router = createSmsRouter([twilio].map((p) => ({ name: p.provider, connector: p.connector, numbers: p.numbers })));
    server = createApp(config, { db, fetchImpl: l27Fetch, connectors: { sms: router }, smsProviders: { twilio } }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    admin = (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boss@urbanmop.ca', password: 'x' }) })).headers.get('set-cookie').split(';')[0];
    await api('/api/me');
  });
  after(async () => {
    server.close();
    await db.close();
  });

  test('health: active account, which numbers can text, which still send incoming texts elsewhere', async () => {
    const ch = (await api('/api/channels')).body.sms;
    assert.equal(ch.state, 'live');
    assert.equal(ch.provider, 'twilio');
    assert.deepEqual(ch.providers.map((p) => p.provider), ['twilio']); // Twilio only
    const t = await twilioDetail();
    assert.equal(t.health_ok, true);
    assert.deepEqual(t.health.account, { sid: `…${SID.slice(-6)}`, name: 'UrbanMop', status: 'active', type: 'Full' });
    assert.deepEqual(t.health.sms_numbers, [HIRING, T2]);
    assert.deepEqual(t.health.not_sms_capable, [T3]);
    assert.deepEqual(t.health.webhook_elsewhere, [T2]);
    assert.equal(t.webhook_url, `${BASE}/webhooks/twilio/sms`);
    assert.deepEqual(t.numbers.map((n) => [n.number, n.can_send, n.queue]), [[HIRING, true, 'Hiring'], [T2, true, 'Fallback'], [T3, false, 'Fallback']]);
    assert.ok(!JSON.stringify(ch).includes(AUTH) && !JSON.stringify(ch).includes(SID));
    assert.deepEqual(ch.problems, []); // nothing was turned down at start-up
    const meta = (await api('/api/meta')).body;
    assert.deepEqual(meta.identities.sms, [HIRING, T2, T3]);
  });

  test('webhook: only Twilio-signed requests are accepted', async () => {
    const p = incoming(CASEY, HIRING, 'hello');
    assert.equal((await twilioPost('/webhooks/twilio/sms', p, { signature: 'forged' })).status, 403);
    const unsigned = await fetch(`${base}/webhooks/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p).toString() });
    assert.equal(unsigned.status, 403);
    // Signed for different content (a changed body) fails too.
    assert.equal((await twilioPost('/webhooks/twilio/sms', { ...p, Body: 'tampered' }, { signature: twilioSignature(AUTH, `${BASE}/webhooks/twilio/sms`, p) })).status, 403);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM sms_events WHERE provider = 'twilio'")).rows[0].n, 0);
  });

  test("inbound: a cleaner's text to the Twilio hiring number lands in Hiring, matched to the cleaner", async () => {
    const p = incoming(CASEY, HIRING, 'Can I pick up more shifts?');
    const res = await twilioPost('/webhooks/twilio/sms', p);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /xml/);
    assert.match(await res.text(), /<Response><\/Response>/); // no automatic reply
    await twilio.processEvents();
    const c = await convFor(CASEY, HIRING);
    assert.equal(c.queue, 'hiring');
    assert.equal(Number(c.l27_team_id), 4760);
    const msg = (await db.query("SELECT * FROM messages WHERE conversation_id = $1 AND kind = 'message'", [c.id])).rows[0];
    assert.equal(msg.body, 'Can I pick up more shifts?');
    assert.equal(msg.external_id, `twilio:sms:${p.MessageSid}`);
    assert.equal(msg.meta.provider, 'twilio');
  });

  test('Twilio retries and the missed-text check never store a text twice', async () => {
    const p = incoming(JANE, HIRING, 'Retried by Twilio');
    await twilioPost('/webhooks/twilio/sms', p);
    await twilioPost('/webhooks/twilio/sms', p);
    tw.inbox.push({ sid: p.MessageSid, from: JANE, to: HIRING, body: p.Body, direction: 'inbound', date_created: new Date().toUTCString() });
    await twilio.processEvents();
    await twilio.reconcile();
    await twilio.processEvents();
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE body = 'Retried by Twilio'")).rows[0].n, 1);
  });

  test('replies leave through Twilio from the conversation\'s number', async () => {
    const hiring = await convFor(CASEY, HIRING);
    const before = tw.sends.length;
    const sent = await api(`/api/conversations/${hiring.id}/messages`, { body: 'Yes, Thursday works', idempotency_key: 't-1' });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.delivery_state, 'queued');
    const out = tw.sends.at(-1);
    assert.equal(tw.sends.length, before + 1);
    assert.deepEqual([out.From, out.To, out.Body], [HIRING, CASEY, 'Yes, Thursday works']);
    assert.equal(out.StatusCallback, `${BASE}/webhooks/twilio/status`);
    assert.equal(sent.body.external_id, `twilio:${out.sid}`);
    assert.equal(sent.body.meta.provider, 'twilio');
    // A conversation on a number that isn't one of our Twilio numbers is not sent anywhere.
    const strayConv = (await db.query("INSERT INTO conversations (channel, our_identity, their_identity) VALUES ('sms', $1, $2) RETURNING id", [NOT_OURS, JANE])).rows[0];
    const stray = await api(`/api/conversations/${strayConv.id}/messages`, { body: 'Hi', idempotency_key: 't-2' });
    assert.notEqual(stray.body?.delivery_state, 'sent');
    assert.notEqual(stray.body?.delivery_state, 'queued');
    assert.equal(tw.sends.length, before + 1);
    // The same send repeated goes out once.
    await api(`/api/conversations/${hiring.id}/messages`, { body: 'Once', idempotency_key: 't-3' });
    await api(`/api/conversations/${hiring.id}/messages`, { body: 'Once', idempotency_key: 't-3' });
    assert.equal(tw.sends.length, before + 2);
  });

  test('delivery status: signed callbacks update it, and polling catches missed callbacks', async () => {
    const [a, b] = tw.sends.slice(-2);
    assert.equal((await twilioPost('/webhooks/twilio/status', { MessageSid: a.sid, MessageStatus: 'delivered' }, { signature: 'nope' })).status, 403);
    assert.equal((await twilioPost('/webhooks/twilio/status', { MessageSid: a.sid, MessageStatus: 'delivered' })).status, 204);
    const stateOf = async (sid) => (await db.query('SELECT delivery_state, meta FROM messages WHERE external_id = $1', [`twilio:${sid}`])).rows[0];
    assert.equal((await stateOf(a.sid)).delivery_state, 'delivered');
    // A late "sent" callback never downgrades delivered.
    await twilioPost('/webhooks/twilio/status', { MessageSid: a.sid, MessageStatus: 'sent' });
    assert.equal((await stateOf(a.sid)).delivery_state, 'delivered');
    // No callback for b: the poll (for texts older than 2 minutes) finds it undelivered.
    tw.statuses.set(b.sid, 'undelivered');
    await db.query("UPDATE messages SET created_at = now() - interval '5 minutes' WHERE external_id = $1", [`twilio:${b.sid}`]);
    await twilio.updateDeliveries();
    const row = await stateOf(b.sid);
    assert.equal(row.delivery_state, 'failed');
    assert.match(row.meta.note, /30003/);
    assert.equal(twilioState('accepted'), 'queued');
  });

  test('opted out with Twilio, rate limits and errors: clear outcomes, never "sent"', async () => {
    const hiring = await convFor(CASEY, HIRING);
    tw.sendPlan.push(21610);
    const optedOut = await api(`/api/conversations/${hiring.id}/messages`, { body: 'x', idempotency_key: 't-4' });
    assert.equal(optedOut.body.delivery_state, 'failed');
    assert.match(optedOut.body.meta.note, /opted out with Twilio/);
    tw.sendPlan.push(429);
    assert.equal((await api(`/api/conversations/${hiring.id}/messages`, { body: 'after 429', idempotency_key: 't-5' })).body.delivery_state, 'queued');
    const before = tw.sends.length;
    tw.sendPlan.push(500);
    const failed = await api(`/api/conversations/${hiring.id}/messages`, { body: 'during an outage', idempotency_key: 't-6' });
    assert.equal(failed.body.delivery_state, 'failed');
    assert.match(failed.body.meta.note, /may or may not have been sent/);
    assert.equal(tw.sends.length, before);
    const notMine = await api(`/api/conversations/${hiring.id}/messages`, { body: 'from a stranger number', from: '+16135559999', idempotency_key: 't-7' });
    assert.equal(notMine.body.delivery_state, 'failed');
    assert.match(notMine.body.meta.note, /isn't one of our SMS numbers/);
    const voiceOnly = await api(`/api/conversations/${hiring.id}/messages`, { body: 'from a voice line', from: T3, idempotency_key: 't-8' });
    assert.match(voiceOnly.body.meta.note, /can't send texts through Twilio/);
  });

  test('STOP sent to a Twilio number blocks texts until START', async () => {
    await twilioPost('/webhooks/twilio/sms', incoming(JANE, T2, 'STOP'));
    await twilio.processEvents();
    const c = await convFor(JANE, T2);
    assert.equal((await api(`/api/conversations/${c.id}/messages`, { body: 'Hello?' })).status, 409);
    await twilioPost('/webhooks/twilio/sms', incoming(JANE, T2, 'START'));
    await twilio.processEvents();
    assert.equal((await api(`/api/conversations/${c.id}/messages`, { body: 'Welcome back', idempotency_key: 't-9' })).status, 201);
  });

  test('a number shared by two customers goes to "Who is this?", never guessed', async () => {
    await twilioPost('/webhooks/twilio/sms', incoming(SHARED, HIRING, 'Need to reschedule'));
    await twilio.processEvents();
    const shared = await convFor(SHARED, HIRING);
    assert.equal(shared.needs_match, true);
    assert.equal(shared.l27_customer_id, null);
    const ev = (await db.query("SELECT meta FROM messages WHERE conversation_id = $1 AND kind = 'event' AND meta->>'type' = 'needs_match'", [shared.id])).rows[0];
    assert.deepEqual(ev.meta.l27_candidates, [81, 82]);
  });

  test('an incoming text that fails to process is retried later, then lands', async () => {
    identifyFails = 1;
    await twilioPost('/webhooks/twilio/sms', incoming('+16135550777', HIRING, 'Hello from a new number'));
    await twilio.processEvents();
    let ev = (await db.query("SELECT * FROM sms_events WHERE provider = 'twilio' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(ev.status, 'pending');
    assert.equal(ev.attempts, 1);
    assert.match(ev.last_error, /timed out/);
    await db.query('UPDATE sms_events SET next_attempt_at = now() WHERE id = $1', [ev.id]);
    await twilio.processEvents();
    ev = (await db.query('SELECT * FROM sms_events WHERE id = $1', [ev.id])).rows[0];
    assert.equal(ev.status, 'done');
    assert.ok(await convFor('+16135550777', HIRING));
  });

  test('webhook downtime: the missed-text check reads each number\'s incoming texts', async () => {
    tw.inbox.push({ sid: 'SMmissed1', from: '+16135550888', to: HIRING, body: 'Missed on hiring', direction: 'inbound', date_created: new Date().toUTCString() }, { sid: 'SMmissed2', from: '+16135550889', to: T2, body: 'Missed on T2', direction: 'inbound', date_created: new Date().toUTCString() }, { sid: 'SMout1', from: HIRING, to: JANE, body: 'outbound', direction: 'outbound-api', date_created: new Date().toUTCString() });
    assert.equal(await twilio.reconcile(), 2);
    await twilio.processEvents();
    assert.ok(await convFor('+16135550888', HIRING));
    assert.ok(await convFor('+16135550889', T2));
    assert.equal(await twilio.reconcile(), 0);
    // Unknown senders go to "Who is this?".
    assert.equal((await convFor('+16135550888', HIRING)).needs_match, true);
  });

  test("admins move the numbers' incoming texts to the portal, and can hand them back exactly", async () => {
    let t = await twilioDetail();
    assert.deepEqual(t.health.webhook_elsewhere, [T2]);
    assert.match(t.receiving, /every minute/); // texts pointed elsewhere are looked for every minute
    tw.updates.length = 0;
    t = (await api('/api/admin/sms/twilio/take-over', {})).body.sms.providers[0];
    // Only T2 moves (HIRING is already ours, T3 can't text).
    assert.deepEqual(tw.updates, [{ sid: 'PN_t2', SmsUrl: `${BASE}/webhooks/twilio/sms`, SmsMethod: 'POST', SmsApplicationSid: '' }]);
    assert.deepEqual(t.health.webhook_elsewhere, []);
    assert.deepEqual(t.handed_over, [T2]);
    assert.match(t.receiving, /^webhook/);
    // A second press changes nothing and keeps the original saved.
    tw.updates.length = 0;
    await api('/api/admin/sms/twilio/take-over', {});
    assert.deepEqual(tw.updates, []);
    // Hand back: T2 points where it pointed before.
    t = (await api('/api/admin/sms/twilio/hand-back', {})).body.sms.providers[0];
    assert.deepEqual(tw.updates, [{ sid: 'PN_t2', SmsUrl: 'https://kustomer.example/twilio', SmsMethod: 'POST', SmsApplicationSid: '' }]);
    assert.deepEqual(t.health.webhook_elsewhere, [T2]);
    assert.deepEqual(t.handed_over, []);
    const audit = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'sms.%' ORDER BY id")).rows.map((r) => r.action);
    assert.ok(audit.includes('sms.take-over') && audit.includes('sms.hand-back'));
  });

  test('a suspended account stops sending; admins disconnect and reconnect Twilio', async () => {
    tw.accountStatus = 'suspended';
    await api('/api/admin/sms/twilio/check', {});
    let t = await twilioDetail();
    assert.equal(t.health_ok, false);
    assert.match(t.last_error, /suspended/);
    const hiring = await convFor(CASEY, HIRING);
    assert.match((await api(`/api/conversations/${hiring.id}/messages`, { body: 'x', idempotency_key: 't-10' })).body.meta.note, /not ready/);
    tw.accountStatus = 'active';
    await api('/api/admin/sms/twilio/check', {});
    assert.equal((await twilioDetail()).health_ok, true);

    await api('/api/admin/sms/twilio/disconnect', {});
    t = await twilioDetail();
    assert.equal(t.enabled, false);
    const p = incoming(CASEY, HIRING, 'While disconnected');
    assert.equal((await twilioPost('/webhooks/twilio/sms', p)).status, 200); // acknowledged, left in Twilio
    assert.equal((await db.query("SELECT count(*)::int AS n FROM sms_events WHERE message_key = $1", [p.MessageSid])).rows[0].n, 0);
    assert.match((await api(`/api/conversations/${hiring.id}/messages`, { body: 'x', idempotency_key: 't-11' })).body.meta.note, /disconnected/);
    tw.inbox.push({ sid: p.MessageSid, from: CASEY, to: HIRING, body: p.Body, direction: 'inbound', date_created: new Date().toUTCString() });
    await api('/api/admin/sms/twilio/connect', {});
    assert.equal((await twilioDetail()).enabled, true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE body = 'While disconnected'")).rows[0].n, 1);
    assert.equal((await api('/api/admin/sms/nope/check', {})).status, 404);
    assert.equal((await api('/api/admin/sms/twilio/delete', {})).status, 404);
  });
});

describe('Twilio outside production', () => {
  test('Twilio settings are ignored in dev and QA; production checks the settings', () => {
    const creds = { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: AUTH, TWILIO_SMS_NUMBERS: HIRING };
    const qa = loadConfig({ ...creds, APP_ENV: 'staging' });
    assert.equal(qa.twilioSms, null);
    assert.ok(qa.warnings.some((w) => /Twilio SMS settings ignored/.test(w)));
    const prod = loadConfig({ ...creds, APP_ENV: 'production', TWILIO_WEBHOOK_BASE_URL: `${BASE}/` });
    assert.deepEqual(prod.twilioSms.numbers, [HIRING]);
    assert.equal(prod.twilioSms.webhookBaseUrl, BASE);
    assert.equal(loadConfig({ ...creds, APP_ENV: 'production', TWILIO_SMS_NUMBERS: '' }).twilioSms, null);
    assert.equal(loadConfig({ ...creds, APP_ENV: 'production', TWILIO_WEBHOOK_BASE_URL: 'http://insecure.example.com' }).twilioSms, null);
    // RingCentral SMS was removed: its old variables are ignored (and named in the log), Twilio still connects.
    const leftover = loadConfig({ ...creds, APP_ENV: 'production', RINGCENTRAL_SMS_CLIENT_ID: 'a', RINGCENTRAL_SMS_CLIENT_SECRET: 'b', RINGCENTRAL_SMS_JWT: 'secret-jwt', RINGCENTRAL_SMS_NUMBERS: HIRING });
    assert.equal(leftover.ringcentralSms, undefined);
    assert.deepEqual(leftover.twilioSms.numbers, [HIRING]);
    const note = leftover.warnings.find((w) => /RingCentral SMS was removed/.test(w));
    assert.match(note, /RINGCENTRAL_SMS_CLIENT_ID, RINGCENTRAL_SMS_CLIENT_SECRET, RINGCENTRAL_SMS_JWT, RINGCENTRAL_SMS_NUMBERS are ignored/);
    assert.ok(!note.includes('secret-jwt'));
    assert.ok(!leftover.smsProblems.some((x) => /RingCentral|only one SMS provider/.test(x.problem)));
    // RingCentral calling is untouched by the removal.
    const calls = loadConfig({ ...creds, APP_ENV: 'production', RINGCENTRAL_CLIENT_ID: 'phone-app', RINGCENTRAL_SERVER: 'https://platform.ringcentral.com' });
    assert.equal(calls.ringcentralClientId, 'phone-app');
    assert.equal(calls.ringcentralRecord, true);
    // Why Twilio is missing is kept for the Channels page: no numbers, or misnamed variables.
    assert.ok(loadConfig({ ...creds, APP_ENV: 'production', TWILIO_SMS_NUMBERS: '' }).smsProblems.some((x) => x.provider === 'twilio' && /TWILIO_SMS_NUMBERS is empty/.test(x.problem)));
    const misnamed = loadConfig({ APP_ENV: 'production', TWILIO_SID: 'x', TWILIO_TOKEN: 'secret-value', TWILIO_SMS_NUMBERS: HIRING });
    const p = misnamed.smsProblems.find((x) => x.provider === 'twilio');
    assert.match(p.problem, /TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set.*TWILIO_SID, TWILIO_SMS_NUMBERS, TWILIO_TOKEN/);
    assert.ok(!p.problem.includes('secret-value')); // names only, never values
    assert.deepEqual(loadConfig({ APP_ENV: 'production' }).smsProblems.filter((x) => x.provider === 'twilio'), []); // Twilio not used: nothing to report
    assert.deepEqual(qa.smsProblems, []); // dev and QA: ignoring Twilio is expected, not a problem
  });

  test('sandboxed (dev, QA, or NOTIFICATIONS_MODE=sandbox): Twilio is never called', async () => {
    const tw = fakeTwilio();
    const db = await openDb();
    const twilio = createTwilioChannel({ db, client: createTwilioClient({ accountSid: SID, authToken: AUTH, fetchImpl: tw.fetchImpl }), smsConfig: { numbers: [HIRING], webhookBaseUrl: BASE, authToken: AUTH } });
    const guarded = guardConnectors({ sms: createSmsRouter([{ name: 'twilio', connector: twilio.connector, numbers: twilio.numbers }]) }, 'sandbox');
    await guarded.sms.send({ channel: 'sms', from: HIRING, to: JANE, body: 'hi' });
    assert.equal(tw.sends.length, 0);
    assert.equal(tw.gets, 0);
    await db.close();
  });
});
