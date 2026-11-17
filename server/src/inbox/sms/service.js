// Live SMS through RingCentral: the provider adapter for sendOutbound(), the webhook for incoming
// texts, a durable queue that feeds them to ingestInbound(), subscription upkeep, a Message
// Store check that recovers anything the webhook missed, delivery status, and a health check.
//
//   RingCentral ──webhook──▶ /webhooks/ringcentral/sms ──▶ sms_events (pending) ──worker──▶ ingestInbound()
//   RingCentral Message Store ──every 5 min──────────────▶ sms_events (same key: never twice)
//   Agent reply ──▶ reply() ──▶ sendOutbound() ──▶ connector.send() ──▶ POST /sms
//
// Sending only happens in production with NOTIFICATIONS_MODE=live: everywhere else the app
// wraps this connector in a sandbox stand-in (channels.js guardConnectors), so no real text is
// ever sent from development or QA.
import { timingSafeEqual } from 'node:crypto';
import { normalizePhone } from '../normalize.js';
import { contactsByIdentity, ingestInbound } from '../service.js';
import { deliveryState, REQUIRED_SCOPES, RingCentralError } from './ringcentral.js';

const PROVIDER = 'ringcentral';
const MIN = 60_000;
const EVERY = { health: 30 * MIN, subscription: 10 * MIN, reconcile: 5 * MIN, delivery: 2 * MIN };
const MAX_EVENT_ATTEMPTS = 8;
// RingCentral sometimes calls its webhook-subscription permission by its older name.
const SCOPE_ALIASES = { WebhookSubscriptions: ['WebhookSubscriptions', 'SubscriptionWebhook'] };

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};
// Error text kept for admins: the reason, never a phone number or message text.
const sanitize = (err) => String(err?.message || err).replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]').slice(0, 300);

/**
 * smsConfig: { numbers: [E.164] allowed business numbers, webhookUrl, webhookToken }
 * identify:  async (phone) => { contact, ambiguous } from Launch27 (lookup.js match)
 */
export function createSmsChannel({ db, client, smsConfig, identify = async () => ({ contact: null, ambiguous: null }), log = () => {}, now = () => Date.now() }) {
  const allowed = [...new Set((smsConfig.numbers || []).map((n) => normalizePhone(n)).filter(Boolean))];
  const last = { health: 0, subscription: 0, reconcile: 0, delivery: 0 };
  let processing = null;
  // The latest state, kept in memory so sending never touches the database: a reply is sent
  // from inside its own transaction, and a second query there could wait on that transaction.
  let cached = null;

  const one = async (sql, p) => (await db.query(sql, p)).rows[0] || null;
  async function state() {
    await db.query('INSERT INTO sms_provider_state (provider) VALUES ($1) ON CONFLICT DO NOTHING', [PROVIDER]);
    cached = await one('SELECT * FROM sms_provider_state WHERE provider = $1', [PROVIDER]);
    return cached;
  }
  const setState = async (fields) => {
    const keys = Object.keys(fields);
    await db.query('INSERT INTO sms_provider_state (provider) VALUES ($1) ON CONFLICT DO NOTHING', [PROVIDER]);
    const row = await one(`UPDATE sms_provider_state SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE provider = $1 RETURNING *`, [PROVIDER, ...keys.map((k) => fields[k])]);
    if (row) cached = row;
    return row;
  };
  const recordError = (what, err) => {
    log('error', `sms: ${what} failed`, { error: sanitize(err) });
    return setState({ last_error: `${what}: ${sanitize(err)}`, last_error_at: new Date(now()) }).catch(() => {});
  };

  // ---------- health: credentials, permissions, extension, SMS-capable numbers ----------

  async function checkHealth() {
    const token = await client.signIn();
    const ext = await client.extension();
    const numbers = await client.phoneNumbers();
    const capable = [...new Set(numbers.filter((n) => (n.features || []).includes('SmsSender')).map((n) => normalizePhone(n.phoneNumber)).filter(Boolean))];
    const wanted = allowed.length ? allowed : capable;
    const scopes = token.scope || [];
    const missing = REQUIRED_SCOPES.filter((s) => !(SCOPE_ALIASES[s] || [s]).some((a) => scopes.includes(a)));
    const health = {
      account_id: ext.account?.id ? String(ext.account.id) : null,
      extension: { id: String(ext.id), number: ext.extensionNumber || null, name: ext.name || null },
      sms_numbers: wanted.filter((n) => capable.includes(n)), // can send and receive here
      not_sms_capable: wanted.filter((n) => !capable.includes(n)), // configured but RingCentral says no
      other_sms_numbers: capable.filter((n) => !wanted.includes(n)), // on the extension, not configured
      missing_scopes: missing,
      checked_at: new Date(now()).toISOString(),
    };
    const ok = !missing.length && health.sms_numbers.length > 0;
    await setState({ health: JSON.stringify(health), health_ok: ok, last_health_at: new Date(now()), ...(ok ? { last_error: null, last_error_at: null } : {}) });
    if (!ok) {
      const why = missing.length ? `the RingCentral app is missing permissions: ${missing.join(', ')}` : 'none of the configured numbers can send SMS on this extension';
      await setState({ last_error: `health: ${why}`, last_error_at: new Date(now()) });
    }
    last.health = now();
    return { ok, health };
  }

  // ---------- outbound ----------

  const connector = {
    name: PROVIDER,
    identities: allowed,
    async send(message) {
      const st = cached;
      if (!st?.last_health_at) throw new Error('RingCentral SMS is still starting up (connection check pending). Try again in a minute.');
      if (!st.enabled) throw new Error('SMS is disconnected in Support settings → Channels.');
      if (!st.health_ok) throw new Error(`RingCentral SMS is not ready${st.last_error ? `: ${st.last_error}` : ''} (see Support settings → Channels).`);
      const eligible = st.health?.sms_numbers || [];
      const from = normalizePhone(message.from) || eligible[0];
      if (!eligible.includes(from)) throw new Error(`${from || 'That number'} can't send texts through RingCentral. Pick one of: ${eligible.join(', ')}.`);
      try {
        const r = await client.sendSms({ from, to: message.to, text: message.body });
        return { id: String(r.id), state: deliveryState(r.messageStatus) };
      } catch (err) {
        if (err instanceof RingCentralError && err.status === 429) throw new Error('RingCentral is limiting texts right now. Wait a minute and send again.');
        if (err instanceof RingCentralError && err.status >= 500) throw new Error(`${err.message}. It may or may not have been sent: check the phone before sending again.`);
        throw err;
      }
    },
  };

  async function updateDeliveries() {
    last.delivery = now();
    const rows = (
      await db.query(
        `SELECT id, external_id FROM messages
         WHERE channel = 'sms' AND direction = 'out' AND delivery_state IN ('queued','sent')
           AND meta->>'provider' = 'ringcentral' AND external_id IS NOT NULL AND created_at > now() - interval '24 hours'
         ORDER BY created_at LIMIT 50`,
      )
    ).rows;
    for (const r of rows) {
      const rcId = r.external_id.replace(/^ringcentral:/, '');
      try {
        const m = await client.message(rcId);
        const stateNow = deliveryState(m.messageStatus);
        await db.query(`UPDATE messages SET delivery_state = $2, meta = meta || $3::jsonb WHERE id = $1 AND delivery_state IS DISTINCT FROM $2`, [r.id, stateNow, JSON.stringify({ delivery_checked_at: new Date(now()).toISOString(), ...(stateNow === 'failed' ? { note: 'RingCentral could not deliver this text.' } : {}) })]);
      } catch (err) {
        if (err.status === 404) await db.query("UPDATE messages SET delivery_state = 'unknown' WHERE id = $1", [r.id]);
        else throw err;
      }
    }
  }

  // ---------- inbound ----------

  const keyOf = (st, m) => `${st?.health?.extension?.id || m.ownerId || 'ext'}:${m.id}`;

  async function enqueue(m, source, st) {
    const res = await db.query(
      `INSERT INTO sms_events (provider, message_key, source, payload) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, message_key) DO NOTHING RETURNING id`,
      [PROVIDER, keyOf(st, m), source, JSON.stringify(m)],
    );
    return res.rows.length > 0;
  }

  async function handleWebhook(req, res) {
    // Subscription set-up: RingCentral checks the address by asking for this header back.
    const validation = req.get('validation-token');
    if (validation) {
      res.set('Validation-Token', validation);
      return res.status(200).end();
    }
    if (!smsConfig.webhookToken || !sameToken(req.get('verification-token'), smsConfig.webhookToken)) return res.status(403).json({ error: 'Not allowed' });
    const n = req.body || {};
    const st = await state();
    if (st.subscription_id && n.subscriptionId && n.subscriptionId !== st.subscription_id) {
      log('warn', 'sms: event from an unknown subscription ignored', { subscription: String(n.subscriptionId).slice(0, 40) });
      return res.status(200).end();
    }
    await setState({ last_webhook_at: new Date(now()) });
    const m = n.body;
    if (!st.enabled || !m || m.type !== 'SMS' || m.direction !== 'Inbound') return res.status(200).end();
    await enqueue(m, 'webhook', st);
    res.status(200).end();
    setImmediate(() => processEvents().catch((err) => recordError('processing', err)));
  }

  async function processOne(ev) {
    const m = ev.payload || {};
    const to = normalizePhone(m.to?.[0]?.phoneNumber);
    const from = normalizePhone(m.from?.phoneNumber);
    if (!from) return { status: 'ignored', reason: 'no sender number' };
    if (allowed.length && !allowed.includes(to)) return { status: 'ignored', reason: 'not one of our SMS numbers' };
    // Who is it in Launch27? Only for numbers we haven't seen (network call outside the transaction).
    const known = await contactsByIdentity(db, 'phone', from);
    const found = known.length ? { contact: null, ambiguous: null } : await identify(from);
    const res = await db.tx((q) =>
      ingestInbound(
        q,
        {
          channel: 'sms',
          from,
          to,
          body: m.subject || '',
          external_id: `ringcentral:sms:${ev.message_key}`,
          at: m.creationTime || undefined,
          meta: { provider: PROVIDER, rc_message_id: String(m.id), rc_conversation_id: m.conversation?.id ? String(m.conversation.id) : undefined, attachments: (m.attachments || []).filter((a) => a.type !== 'Text').length || undefined },
        },
        { lookup: found.contact, ambiguousCandidates: found.ambiguous, flagUnmatched: true, now: new Date(now()) },
      ),
    );
    await setState({ last_received_at: new Date(now()) });
    return { status: 'done', conversation_id: res.conversationId };
  }

  async function processEvents() {
    if (processing) return processing;
    processing = (async () => {
      const due = (await db.query("SELECT * FROM sms_events WHERE provider = $1 AND status = 'pending' AND next_attempt_at <= $2 ORDER BY id LIMIT 25", [PROVIDER, new Date(now())])).rows;
      for (const ev of due) {
        try {
          const r = await processOne(ev);
          await db.query('UPDATE sms_events SET status = $2, conversation_id = $3, last_error = $4, payload = NULL, processed_at = now(), attempts = attempts + 1 WHERE id = $1', [ev.id, r.status, r.conversation_id ?? null, r.reason ?? null]);
        } catch (err) {
          const attempts = ev.attempts + 1;
          const failed = attempts >= MAX_EVENT_ATTEMPTS;
          const wait = Math.min(60, 2 ** attempts) * MIN; // 2, 4, 8 … up to 60 minutes
          await db.query('UPDATE sms_events SET attempts = $2, status = $3, next_attempt_at = $4, last_error = $5 WHERE id = $1', [ev.id, attempts, failed ? 'failed' : 'pending', new Date(now() + wait), sanitize(err)]);
          log(failed ? 'error' : 'warn', 'sms: could not process an incoming text', { event: ev.id, attempts, error: sanitize(err) });
        }
      }
      return due.length;
    })().finally(() => {
      processing = null;
    });
    return processing;
  }

  // Missed webhooks (downtime, a lapsed subscription): read the Message Store and queue anything
  // not seen. Overlaps the last check by 10 minutes; the unique key makes that harmless.
  async function reconcile() {
    last.reconcile = now();
    const st = await state();
    if (!st.enabled) return 0;
    const started = new Date(now());
    const from = new Date((st.reconcile_from ? new Date(st.reconcile_from).getTime() : now() - 60 * MIN) - 10 * MIN);
    const records = await client.inboundSince(from.toISOString());
    let added = 0;
    for (const m of records) if (m.type === 'SMS' && m.direction === 'Inbound' && (await enqueue(m, 'reconcile', st))) added++;
    await setState({ reconcile_from: started, last_reconcile_at: started });
    if (added) log('info', 'sms: recovered texts the webhook missed', { count: added });
    return added;
  }

  // ---------- webhook subscription upkeep ----------

  async function ensureSubscription() {
    last.subscription = now();
    const st = await state();
    if (!st.enabled || !smsConfig.webhookUrl || !smsConfig.webhookToken) return { mode: 'polling' };
    let id = st.subscription_id;
    if (id) {
      try {
        const sub = await client.subscription(id);
        if (sub.status !== 'Active') {
          await client.deleteSubscription(id).catch(() => {});
          id = null;
        } else if (new Date(sub.expirationTime).getTime() - now() < 2 * 24 * 60 * MIN) {
          const renewed = await client.renewSubscription(id);
          await setState({ subscription_expires_at: new Date(renewed.expirationTime) });
          log('info', 'sms: webhook subscription renewed', { expires: renewed.expirationTime });
        } else if (!st.subscription_expires_at) await setState({ subscription_expires_at: new Date(sub.expirationTime) });
      } catch (err) {
        if (err.status !== 404) throw err;
        id = null;
      }
    }
    if (!id) {
      const sub = await client.createSubscription({ address: smsConfig.webhookUrl, verificationToken: smsConfig.webhookToken });
      await setState({ subscription_id: String(sub.id), subscription_expires_at: new Date(sub.expirationTime) });
      log('info', 'sms: webhook subscription created', { expires: sub.expirationTime });
    }
    return { mode: 'webhook' };
  }

  async function guarded(what, fn) {
    try {
      return await fn();
    } catch (err) {
      await recordError(what, err);
      return null;
    }
  }

  return {
    connector,
    handleWebhook,
    processEvents,
    reconcile,
    ensureSubscription,
    checkHealth,
    updateDeliveries,
    /** Admin "Check now": health, recording any problem for the Channels screen. */
    check: () => guarded('health', checkHealth),
    /** Startup: health, then the webhook subscription. Never throws. */
    async start() {
      await guarded('health', checkHealth);
      await guarded('subscription', ensureSubscription);
    },
    /** Called by the worker every tick (30 s by default). */
    async tick() {
      const st = await state();
      await guarded('processing', processEvents);
      if (!st.enabled) return;
      const t = now();
      if (t - last.health >= EVERY.health) await guarded('health', checkHealth);
      if (t - last.subscription >= EVERY.subscription) await guarded('subscription', ensureSubscription);
      if (t - last.reconcile >= EVERY.reconcile) await guarded('message store check', reconcile);
      if (t - last.delivery >= EVERY.delivery) await guarded('delivery status', updateDeliveries);
    },
    async status() {
      const st = await state();
      const counts = (await db.query("SELECT status, count(*)::int AS n FROM sms_events WHERE provider = $1 GROUP BY status", [PROVIDER])).rows;
      return {
        provider: PROVIDER,
        enabled: st.enabled,
        health_ok: st.health_ok,
        health: st.health,
        configured_numbers: allowed,
        receiving: smsConfig.webhookUrl && smsConfig.webhookToken ? 'webhook + Message Store check every 5 minutes' : 'Message Store check every 5 minutes (no webhook address set)',
        subscription_expires_at: st.subscription_expires_at,
        has_subscription: !!st.subscription_id,
        last_webhook_at: st.last_webhook_at,
        last_received_at: st.last_received_at,
        last_reconcile_at: st.last_reconcile_at,
        last_health_at: st.last_health_at,
        last_error: st.last_error,
        last_error_at: st.last_error_at,
        events: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      };
    },
    /** Admin: stop sending and receiving (removes the webhook subscription). */
    async disconnect() {
      const st = await state();
      if (st.subscription_id) await client.deleteSubscription(st.subscription_id).catch((err) => log('warn', 'sms: could not delete the subscription', { error: sanitize(err) }));
      await setState({ enabled: false, subscription_id: null, subscription_expires_at: null });
    },
    /** Admin: start again (health check, subscription, catch up on missed texts). */
    async connect() {
      await setState({ enabled: true });
      await guarded('health', checkHealth);
      await guarded('subscription', ensureSubscription);
      await guarded('message store check', reconcile);
      await guarded('processing', processEvents);
    },
  };
}
