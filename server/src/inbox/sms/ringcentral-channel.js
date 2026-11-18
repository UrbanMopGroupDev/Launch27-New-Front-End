// Live SMS through RingCentral: the provider adapter, the webhook for incoming texts,
// subscription upkeep, a Message Store check that recovers anything the webhook missed,
// delivery status, and a health check. Incoming texts go through the shared queue (core.js).
//
//   RingCentral ──webhook──▶ /webhooks/ringcentral/sms ──▶ sms_events ──worker──▶ ingestInbound()
//   RingCentral Message Store ──every 5 min──────────────▶ sms_events (same key: never twice)
//   Agent reply ──▶ reply() ──▶ sendOutbound() ──▶ router ──▶ connector.send() ──▶ POST /sms
//
// Sending only happens in production with NOTIFICATIONS_MODE=live: everywhere else the app
// wraps the SMS connector in a sandbox stand-in (channels.js guardConnectors).
import { normalizePhone } from '../normalize.js';
import { deliveryState, REQUIRED_SCOPES, RingCentralError } from './ringcentral.js';
import { createInboundQueue, createProviderState, MIN, sameToken, sanitize } from './core.js';

const PROVIDER = 'ringcentral';
const EVERY = { health: 30 * MIN, subscription: 10 * MIN, reconcile: 5 * MIN, delivery: 2 * MIN };
// RingCentral sometimes calls its webhook-subscription permission by its older name.
const SCOPE_ALIASES = { WebhookSubscriptions: ['WebhookSubscriptions', 'SubscriptionWebhook'] };

/**
 * smsConfig: { numbers: [E.164] allowed business numbers, webhookUrl, webhookToken }
 * identify:  async (phone) => { contact, ambiguous } from Launch27 (lookup.js match)
 */
export function createRingCentralChannel({ db, client, smsConfig, identify, log = () => {}, now = () => Date.now() }) {
  const allowed = [...new Set((smsConfig.numbers || []).map((n) => normalizePhone(n)).filter(Boolean))];
  const last = { health: 0, subscription: 0, reconcile: 0, delivery: 0 };
  const ps = createProviderState(db, PROVIDER, { log, now });
  const { state, setState, guarded } = ps;
  const queue = createInboundQueue({ db, provider: PROVIDER, allowed, identify, log, now, onReceived: () => setState({ last_received_at: new Date(now()) }) });

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
      const st = ps.cached();
      if (!st?.last_health_at) throw new Error('RingCentral SMS is still starting up (connection check pending). Try again in a minute.');
      if (!st.enabled) throw new Error('RingCentral SMS is disconnected in Support settings → Channels.');
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
        await db.query('UPDATE messages SET delivery_state = $2, meta = meta || $3::jsonb WHERE id = $1 AND delivery_state IS DISTINCT FROM $2', [r.id, stateNow, JSON.stringify({ delivery_checked_at: new Date(now()).toISOString(), ...(stateNow === 'failed' ? { note: 'RingCentral could not deliver this text.' } : {}) })]);
      } catch (err) {
        if (err.status === 404) await db.query("UPDATE messages SET delivery_state = 'unknown' WHERE id = $1", [r.id]);
        else throw err;
      }
    }
  }

  // ---------- inbound ----------

  // RingCentral message (webhook body or Message Store record) -> the shared queue's shape.
  const toText = (st, m) => ({
    key: `${st?.health?.extension?.id || m.ownerId || 'ext'}:${m.id}`,
    id: String(m.id),
    from: m.from?.phoneNumber,
    to: m.to?.[0]?.phoneNumber,
    body: m.subject || '',
    at: m.creationTime || null,
    meta: { rc_message_id: String(m.id), rc_conversation_id: m.conversation?.id ? String(m.conversation.id) : undefined, attachments: (m.attachments || []).filter((a) => a.type !== 'Text').length || undefined },
  });

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
      log('warn', 'sms (ringcentral): event from an unknown subscription ignored', { subscription: String(n.subscriptionId).slice(0, 40) });
      return res.status(200).end();
    }
    await setState({ last_webhook_at: new Date(now()) });
    const m = n.body;
    if (!st.enabled || !m || m.type !== 'SMS' || m.direction !== 'Inbound') return res.status(200).end();
    await queue.enqueue(toText(st, m), 'webhook');
    res.status(200).end();
    setImmediate(() => queue.processEvents().catch((err) => ps.recordError('processing', err)));
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
    for (const m of records) if (m.type === 'SMS' && m.direction === 'Inbound' && (await queue.enqueue(toText(st, m), 'reconcile'))) added++;
    await setState({ reconcile_from: started, last_reconcile_at: started });
    if (added) log('info', 'sms (ringcentral): recovered texts the webhook missed', { count: added });
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
          log('info', 'sms (ringcentral): webhook subscription renewed', { expires: renewed.expirationTime });
        } else if (!st.subscription_expires_at) await setState({ subscription_expires_at: new Date(sub.expirationTime) });
      } catch (err) {
        if (err.status !== 404) throw err;
        id = null;
      }
    }
    if (!id) {
      const sub = await client.createSubscription({ address: smsConfig.webhookUrl, verificationToken: smsConfig.webhookToken });
      await setState({ subscription_id: String(sub.id), subscription_expires_at: new Date(sub.expirationTime) });
      log('info', 'sms (ringcentral): webhook subscription created', { expires: sub.expirationTime });
    }
    return { mode: 'webhook' };
  }

  return {
    provider: PROVIDER,
    numbers: allowed,
    connector,
    handleWebhook,
    processEvents: queue.processEvents,
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
      await guarded('processing', queue.processEvents);
      if (!st.enabled) return;
      const t = now();
      if (t - last.health >= EVERY.health) await guarded('health', checkHealth);
      if (t - last.subscription >= EVERY.subscription) await guarded('subscription', ensureSubscription);
      if (t - last.reconcile >= EVERY.reconcile) await guarded('message store check', reconcile);
      if (t - last.delivery >= EVERY.delivery) await guarded('delivery status', updateDeliveries);
    },
    async status() {
      const st = await state();
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
        events: await queue.counts(),
      };
    },
    /** Admin: stop sending and receiving (removes the webhook subscription). */
    async disconnect() {
      const st = await state();
      if (st.subscription_id) await client.deleteSubscription(st.subscription_id).catch((err) => log('warn', 'sms (ringcentral): could not delete the subscription', { error: sanitize(err) }));
      await setState({ enabled: false, subscription_id: null, subscription_expires_at: null });
    },
    /** Admin: start again (health check, subscription, catch up on missed texts). */
    async connect() {
      await setState({ enabled: true });
      await guarded('health', checkHealth);
      await guarded('subscription', ensureSubscription);
      await guarded('message store check', reconcile);
      await guarded('processing', queue.processEvents);
    },
  };
}
