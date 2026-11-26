// Live SMS through Twilio: every business number texts through Twilio.
//
//   Twilio ──signed webhook──▶ /webhooks/twilio/sms ──▶ sms_events ──worker──▶ ingestInbound()
//   Twilio Messages list ──every 5 min, per number──▶ sms_events (same key: never twice)
//   Agent reply ──▶ reply() ──▶ sendOutbound() ──▶ router ──▶ connector.send() ──▶ POST Messages.json
//   Twilio ──signed status callback──▶ /webhooks/twilio/status ──▶ delivery_state
//
// The numbers' "A message comes in" webhook is set in the Twilio console, not by this app: the
// numbers may still be in use elsewhere (e.g. Kustomer) until UrbanMop switches them over. The
// health check shows which numbers point here.
import { normalizePhone } from '../normalize.js';
import { createInboundQueue, createProviderState, MIN } from './core.js';
import { TwilioError, twilioState, validTwilioSignature } from './twilio.js';

const PROVIDER = 'twilio';
const EVERY = { health: 30 * MIN, reconcile: 5 * MIN, delivery: 2 * MIN };
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * smsConfig: { numbers: [E.164], webhookBaseUrl: 'https://app.example.com' | null, authToken }
 * identify:  async (phone) => { contact, ambiguous } from Launch27 (lookup.js match)
 */
export function createTwilioChannel({ db, client, smsConfig, identify, log = () => {}, now = () => Date.now() }) {
  const allowed = [...new Set((smsConfig.numbers || []).map((n) => normalizePhone(n)).filter(Boolean))];
  const base = smsConfig.webhookBaseUrl ? smsConfig.webhookBaseUrl.replace(/\/+$/, '') : null;
  const smsUrl = base ? `${base}/webhooks/twilio/sms` : null;
  const statusUrl = base ? `${base}/webhooks/twilio/status` : null;
  const last = { health: 0, reconcile: 0, delivery: 0 };
  const ps = createProviderState(db, PROVIDER, { log, now });
  const { state, setState, guarded } = ps;
  const queue = createInboundQueue({ db, provider: PROVIDER, allowed, identify, log, now, onReceived: () => setState({ last_received_at: new Date(now()) }) });

  // ---------- health: account, numbers that can text, where their incoming texts go ----------

  async function checkHealth() {
    const account = await client.account();
    const numbers = await client.incomingNumbers();
    const byNumber = new Map(numbers.map((n) => [normalizePhone(n.phone_number), n]));
    const capable = numbers.filter((n) => n.capabilities?.sms).map((n) => normalizePhone(n.phone_number)).filter(Boolean);
    const health = {
      account: { sid: `…${String(account.sid || '').slice(-6)}`, name: account.friendly_name || null, status: account.status || null, type: account.type || null },
      sms_numbers: allowed.filter((n) => capable.includes(n)),
      not_sms_capable: allowed.filter((n) => !capable.includes(n)),
      // Numbers whose incoming texts are sent somewhere else (another app, Kustomer, a TwiML bin).
      webhook_elsewhere: smsUrl ? allowed.filter((n) => capable.includes(n) && byNumber.get(n).sms_url !== smsUrl) : [],
      checked_at: new Date(now()).toISOString(),
    };
    const ok = account.status === 'active' && health.sms_numbers.length > 0;
    await setState({ health: JSON.stringify(health), health_ok: ok, last_health_at: new Date(now()), ...(ok ? { last_error: null, last_error_at: null } : {}) });
    if (!ok) {
      const why = account.status !== 'active' ? `the Twilio account is ${account.status || 'not active'}` : 'none of the configured numbers can send SMS on this Twilio account';
      await setState({ last_error: `health: ${why}`, last_error_at: new Date(now()) });
    }
    last.health = now();
    return { ok, health };
  }

  // ---------- moving the numbers' incoming texts to the portal (and back) ----------
  // Until then the numbers send incoming texts somewhere else (Kustomer) and the portal only
  // finds them with the missed-text check. Moving a number saves where it pointed before,
  // first, so "Hand back" restores it exactly. Only our configured, SMS-capable numbers.

  const savedOf = (st) => (st?.previous_webhooks && typeof st.previous_webhooks === 'object' ? { ...st.previous_webhooks } : {});

  async function takeOver() {
    if (!smsUrl) throw new Error('TWILIO_WEBHOOK_BASE_URL is not set, so there is no portal address to send the texts to.');
    const saved = savedOf(await state());
    const moved = [];
    for (const n of await client.incomingNumbers()) {
      const num = normalizePhone(n.phone_number);
      if (!allowed.includes(num) || !n.capabilities?.sms) continue;
      if (n.sms_url === smsUrl && !n.sms_application_sid) continue;
      if (!saved[num]) {
        saved[num] = { sms_url: n.sms_url || '', sms_method: n.sms_method || 'POST', sms_application_sid: n.sms_application_sid || '', saved_at: new Date(now()).toISOString() };
        await setState({ previous_webhooks: JSON.stringify(saved) });
      }
      await client.updateNumber(n.sid, { SmsUrl: smsUrl, SmsMethod: 'POST', SmsApplicationSid: '' });
      moved.push(num);
    }
    log('info', 'sms (twilio): incoming texts moved to the portal', { numbers: moved.length });
    await checkHealth();
    return moved;
  }

  async function handBack() {
    const saved = savedOf(await state());
    const byNumber = new Map((await client.incomingNumbers()).map((n) => [normalizePhone(n.phone_number), n]));
    const back = [];
    for (const [num, prev] of Object.entries(saved)) {
      const n = byNumber.get(num);
      if (n) {
        await client.updateNumber(n.sid, { SmsUrl: prev.sms_url || '', SmsMethod: prev.sms_method || 'POST', SmsApplicationSid: prev.sms_application_sid || '' });
        back.push(num);
      }
      delete saved[num];
      await setState({ previous_webhooks: Object.keys(saved).length ? JSON.stringify(saved) : null });
    }
    log('info', 'sms (twilio): incoming texts handed back', { numbers: back.length });
    await checkHealth();
    return back;
  }

  // While some numbers still send their texts elsewhere, look for missed texts every minute.
  const reconcileEvery = (st) => ((st?.health?.webhook_elsewhere || []).length ? MIN : EVERY.reconcile);

  // ---------- outbound ----------

  const connector = {
    name: PROVIDER,
    identities: allowed,
    async send(message) {
      const st = ps.cached();
      if (!st?.last_health_at) throw new Error('Twilio SMS is still starting up (connection check pending). Try again in a minute.');
      if (!st.enabled) throw new Error('Twilio SMS is disconnected in Support settings → Channels.');
      if (!st.health_ok) throw new Error(`Twilio SMS is not ready${st.last_error ? `: ${st.last_error}` : ''} (see Support settings → Channels).`);
      const eligible = st.health?.sms_numbers || [];
      const from = normalizePhone(message.from) || eligible[0];
      if (!eligible.includes(from)) throw new Error(`${from || 'That number'} can't send texts through Twilio. Pick one of: ${eligible.join(', ')}.`);
      try {
        const r = await client.sendSms({ from, to: message.to, body: message.body, statusCallback: statusUrl });
        return { id: String(r.sid), state: twilioState(r.status) };
      } catch (err) {
        if (err instanceof TwilioError && err.code === 21610) throw new Error('This person has opted out with Twilio (they replied STOP). Twilio blocks texts to them until they reply START.');
        if (err instanceof TwilioError && err.status === 429) throw new Error('Twilio is limiting texts right now. Wait a minute and send again.');
        if (err instanceof TwilioError && err.status >= 500) throw new Error(`${err.message}. It may or may not have been sent: check before sending again.`);
        throw err;
      }
    },
  };

  const setDelivery = (sid, status, errorCode = null) => {
    const stateNow = twilioState(status);
    const note = stateNow === 'failed' ? `Twilio could not deliver this text${errorCode ? ` (error ${errorCode})` : ''}.` : null;
    return db.query(
      "UPDATE messages SET delivery_state = $2, meta = meta || $3::jsonb WHERE external_id = $1 AND delivery_state IS DISTINCT FROM $2 AND delivery_state NOT IN ('delivered')",
      [`twilio:${sid}`, stateNow, JSON.stringify({ delivery_checked_at: new Date(now()).toISOString(), ...(note ? { note } : {}) })],
    );
  };

  // Status callbacks normally keep this current; this catches any that didn't arrive.
  async function updateDeliveries() {
    last.delivery = now();
    const rows = (
      await db.query(
        `SELECT external_id FROM messages
         WHERE channel = 'sms' AND direction = 'out' AND delivery_state IN ('queued','sent')
           AND meta->>'provider' = 'twilio' AND external_id IS NOT NULL
           AND created_at > now() - interval '24 hours' AND created_at < now() - interval '2 minutes'
         ORDER BY created_at LIMIT 50`,
      )
    ).rows;
    for (const r of rows) {
      const sid = r.external_id.replace(/^twilio:/, '');
      try {
        const m = await client.message(sid);
        await setDelivery(sid, m.status, m.error_code);
      } catch (err) {
        if (err.status === 404) await db.query("UPDATE messages SET delivery_state = 'unknown' WHERE external_id = $1", [r.external_id]);
        else throw err;
      }
    }
  }

  // ---------- inbound ----------

  const verified = (req) => validTwilioSignature(smsConfig.authToken, `${base}${req.originalUrl}`, req.body || {}, req.get('x-twilio-signature'));

  const toText = (m) => ({
    key: String(m.MessageSid || m.sid),
    id: String(m.MessageSid || m.sid),
    from: m.From || m.from,
    to: m.To || m.to,
    body: m.Body ?? m.body ?? '',
    at: m.date_created ? new Date(m.date_created).toISOString() : new Date(now()).toISOString(),
    meta: { twilio_sid: String(m.MessageSid || m.sid), media: Number(m.NumMedia || m.num_media || 0) || undefined },
  });

  async function handleWebhook(req, res) {
    if (!base || !verified(req)) return res.status(403).type('text/plain').send('Not allowed');
    const st = await state();
    await setState({ last_webhook_at: new Date(now()) });
    const m = req.body || {};
    // While disconnected the text is left in Twilio; the catch-up on reconnect brings it in.
    if (st.enabled && m.MessageSid && m.From) {
      await queue.enqueue(toText(m), 'webhook');
      setImmediate(() => queue.processEvents().catch((err) => ps.recordError('processing', err)));
    }
    res.status(200).type('text/xml').send(TWIML_EMPTY); // no automatic reply
  }

  async function handleStatus(req, res) {
    if (!base || !verified(req)) return res.status(403).type('text/plain').send('Not allowed');
    const m = req.body || {};
    if (m.MessageSid && m.MessageStatus) await setDelivery(m.MessageSid, m.MessageStatus, m.ErrorCode || null);
    res.status(204).end();
  }

  // Missed webhooks: list each number's incoming texts since the last check (10 minutes' overlap).
  async function reconcile() {
    last.reconcile = now();
    const st = await state();
    if (!st.enabled) return 0;
    const started = new Date(now());
    const since = new Date((st.reconcile_from ? new Date(st.reconcile_from).getTime() : now() - 60 * MIN) - 10 * MIN);
    let added = 0;
    for (const n of st.health?.sms_numbers || allowed) {
      for (const m of await client.inboundTo(n, since)) if (await queue.enqueue(toText(m), 'reconcile')) added++;
    }
    await setState({ reconcile_from: started, last_reconcile_at: started });
    if (added) log('info', 'sms (twilio): recovered texts the webhook missed', { count: added });
    return added;
  }

  return {
    provider: PROVIDER,
    numbers: allowed,
    connector,
    handleWebhook,
    handleStatus,
    processEvents: queue.processEvents,
    reconcile,
    checkHealth,
    updateDeliveries,
    check: () => guarded('health', checkHealth),
    takeOver,
    handBack,
    async start() {
      await guarded('health', checkHealth);
    },
    async tick() {
      const st = await state();
      await guarded('processing', queue.processEvents);
      if (!st.enabled) return;
      const t = now();
      if (t - last.health >= EVERY.health) await guarded('health', checkHealth);
      if (t - last.reconcile >= reconcileEvery(st)) await guarded('missed-text check', reconcile);
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
        receiving: !smsUrl
          ? 'missed-text check every 5 minutes (no webhook address set)'
          : (st.health?.webhook_elsewhere || []).length
            ? 'missed-text check every minute: some numbers still send their texts somewhere else'
            : 'webhook + missed-text check every 5 minutes',
        handed_over: Object.keys(savedOf(st)),
        webhook_url: smsUrl,
        status_callback_url: statusUrl,
        last_webhook_at: st.last_webhook_at,
        last_received_at: st.last_received_at,
        last_reconcile_at: st.last_reconcile_at,
        last_health_at: st.last_health_at,
        last_error: st.last_error,
        last_error_at: st.last_error_at,
        events: await queue.counts(),
      };
    },
    async disconnect() {
      await setState({ enabled: false });
    },
    async connect() {
      await setState({ enabled: true });
      await guarded('health', checkHealth);
      await guarded('missed-text check', reconcile);
      await guarded('processing', queue.processEvents);
    },
  };
}
