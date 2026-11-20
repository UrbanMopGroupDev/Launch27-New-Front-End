// Channel connectors. Each channel that can send has one:
//
//   connectors.email = { name: 'gmail',  identities: [...], send: async ({ from, to, subject, body, thread, attachments }) => ({ id, thread_key, message_id, mailbox }) }
//   connectors.sms   = { name: 'twilio', send: async ({ from, to, body }) => ({ id }) }
//
// Email is Gmail (server/src/inbox/email/), connected in production when GMAIL_* is set; its
// inbound side is the mailbox sync in email/sync.js, which calls ingestInbound() with the
// message's Message-ID as external_id, so mail read twice is stored once. SMS is not
// connected yet: replies are saved and shown as "not sent", and inbound texts come from the
// simulator (POST /api/simulate/inbound).

// Email can be read and sent (replies, new email conversations, attached files). Production
// sends through Gmail; development and QA record every email as a sandbox message and send
// nothing (guardConnectors). This is a code constant on purpose: making email read-only again
// is an approved code change, not a setting. When false, replies and new email conversations
// are refused (service.js, api.js) and the connector the app gets cannot send.
export const EMAIL_SENDING_ENABLED = true;
export const EMAIL_READ_ONLY_MESSAGE = "Email is read-only: emails can't be sent from this platform. Reply by text, or add an internal note.";

// Outside production, connectors are wrapped so nothing reaches a real customer: the
// message is recorded with delivery state "sandbox". See guardConnectors().
export async function sendOutbound(message, connectors = {}) {
  // Backstop: even if a caller gets here, an email is never handed to a connector.
  if (message.channel === 'email' && !EMAIL_SENDING_ENABLED) {
    return { state: 'not_sent', provider: null, note: EMAIL_READ_ONLY_MESSAGE };
  }
  const connector = connectors[message.channel];
  if (connector?.sandbox) {
    return { state: 'sandbox', provider: connector.name, note: 'Sandbox environment: recorded, not sent to the customer.' };
  }
  if (!connector) {
    return { state: 'not_connected', provider: null, note: `${message.channel.toUpperCase()} isn't connected yet, so this was saved but not sent.` };
  }
  try {
    const res = await connector.send(message);
    // A provider may report its own status (e.g. Twilio: queued, sent, delivered).
    // A router (several SMS providers) says which one sent it.
    const provider = res?.provider || connector.name;
    return { state: res?.state || 'sent', provider, provider_id: res?.id || null, external_id: res?.id ? `${provider}:${res.id}` : null, thread_key: res?.thread_key || null, message_id: res?.message_id || null, mailbox: res?.mailbox || null };
  } catch (err) {
    return { state: 'failed', provider: connector.name, note: err.message };
  }
}

export const connectedChannels = (connectors = {}) => Object.keys(connectors);

/** Addresses a channel can actually send from, or null when any of ours will do. */
export const sendableIdentities = (connectors = {}, channel) => connectors[channel]?.identities || null;

/** In any mode other than 'live', replace each connector with a sandbox stand-in that never sends. */
export function guardConnectors(connectors = {}, mode = 'sandbox') {
  const guarded = mode === 'live' ? { ...connectors } : Object.fromEntries(Object.entries(connectors).map(([channel, c]) => [channel, { name: c.name, identities: c.identities, sandbox: true, send: async () => ({ id: null }) }]));
  // Read-only email: whatever the mode, the email connector the app sees cannot send.
  if (guarded.email && !EMAIL_SENDING_ENABLED) {
    const c = guarded.email;
    guarded.email = {
      name: c.name,
      identities: c.identities,
      sandbox: !!c.sandbox,
      readOnly: true,
      send: async () => {
        throw new Error(EMAIL_READ_ONLY_MESSAGE);
      },
      // Reading a file off a received email is still allowed (live only: sandboxes have none).
      ...(typeof c.attachment === 'function' && !c.sandbox ? { attachment: c.attachment } : {}),
    };
  }
  return guarded;
}

/** Dev and QA: email works end to end (compose, thread, route) but every send is a sandbox record. */
export const sandboxEmail = () => ({ name: 'sandbox', send: async () => ({ id: null }) });

/** Dev and QA (no Twilio): texts work end to end, every send is a sandbox record. */
export const sandboxSms = () => ({ name: 'sandbox', send: async () => ({ id: null }) });
