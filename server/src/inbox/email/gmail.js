// Gmail (Google Workspace) as the email channel: send replies from our addresses and read
// what customers send to them. Plain REST calls with node's fetch and crypto; no SDK.
//
// Two ways to sign in (see docs/email.md):
//   - a service account with domain-wide delegation: one key reads and sends for every
//     @urbanmop.ca mailbox listed in GMAIL_MAILBOXES (recommended);
//   - an OAuth refresh token for a single mailbox (its send-as aliases can still be listed).
// Scopes: read (gmail.readonly) and send (gmail.send), each asked for only when used, so
// reading keeps working even before Google Workspace has allowed sending. We never delete,
// label or mark mail as read, so the team can keep using Gmail alongside the inbox.
import { createSign, randomUUID } from 'node:crypto';
import { normalizeEmail } from '../normalize.js';
import { attachmentParts, buildMessage, toBase64Url } from './mime.js';

// A service account must be allowed both scopes in Google Workspace (domain-wide delegation).
// Reading and sending use separate sign-ins: if sending isn't allowed yet, only sends fail.
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_SCOPES = [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users';
const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const LARGE_FROM = 3_000_000; // characters of the finished message: bigger ones go by upload

export class GmailError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * "info@x.ca, billing@x.ca, help@x.ca=info@x.ca" ->
 *   accounts: mailboxes we sign in to and read (info, billing)
 *   sendAs:   address -> mailbox that sends it (help is a send-as alias of info)
 */
export function parseMailboxes(value) {
  const accounts = [];
  const sendAs = new Map();
  for (const entry of String(value || '').split(/[,\s]+/).filter(Boolean)) {
    const [addr, via] = entry.split('=');
    const address = normalizeEmail(addr);
    const account = normalizeEmail(via || addr);
    if (!address || !account) continue;
    if (!accounts.includes(account)) accounts.push(account);
    sendAs.set(address, account);
    if (!sendAs.has(account)) sendAs.set(account, account);
  }
  return { accounts, sendAs };
}

/** Parse GMAIL_SERVICE_ACCOUNT_JSON (raw JSON or base64 of it). Returns null when unusable. */
export function parseServiceAccount(value) {
  if (!value) return null;
  const text = String(value).trim();
  for (const candidate of [text, Buffer.from(text, 'base64').toString('utf8')]) {
    try {
      const sa = JSON.parse(candidate);
      if (sa.client_email && sa.private_key) return { client_email: sa.client_email, private_key: sa.private_key.replace(/\\n/g, '\n') };
    } catch {
      // try the next form
    }
  }
  return null;
}

export function createGmailClient({ auth, fetchImpl = fetch, now = () => Date.now() }) {
  const tokens = new Map(); // account|scope -> { token, exp }

  async function tokenRequest(params) {
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new GmailError(res.status, `Google sign-in failed: ${body.error_description || body.error || res.status}`);
    return { token: body.access_token, exp: now() + (Number(body.expires_in) || 3600) * 1000 - 60_000 };
  }

  async function token(account, scope = GMAIL_READ_SCOPE) {
    const key = `${auth.serviceAccount ? account : '*'}|${scope}`;
    const cached = tokens.get(key);
    if (cached && cached.exp > now()) return cached.token;
    let fresh;
    if (auth.serviceAccount) {
      const iat = Math.floor(now() / 1000);
      const claims = { iss: auth.serviceAccount.client_email, sub: account, scope, aud: TOKEN_URL, iat, exp: iat + 3600 };
      const unsigned = `${toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${toBase64Url(JSON.stringify(claims))}`;
      const signature = createSign('RSA-SHA256').update(unsigned).sign(auth.serviceAccount.private_key).toString('base64url');
      fresh = await tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` });
    } else {
      fresh = await tokenRequest({ grant_type: 'refresh_token', client_id: auth.clientId, client_secret: auth.clientSecret, refresh_token: auth.refreshToken });
    }
    tokens.set(key, fresh);
    return fresh.token;
  }

  async function call(account, method, path, { query, body, scope = GMAIL_READ_SCOPE } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v == null ? [] : [[k, String(v)]]))).toString()}` : '';
    const res = await fetchImpl(`${API}/${encodeURIComponent(account)}${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${await token(account, scope)}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) tokens.delete(`${auth.serviceAccount ? account : '*'}|${scope}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GmailError(res.status, `Gmail ${res.status}: ${data.error?.message || res.statusText || 'request failed'}`);
    return data;
  }

  return {
    profile: (account) => call(account, 'GET', '/profile'),
    /** New INBOX message ids since a history id. Throws GmailError 404 when the id is too old. */
    async changes(account, startHistoryId) {
      const ids = [];
      let pageToken;
      let historyId = startHistoryId;
      do {
        const page = await call(account, 'GET', '/history', { query: { startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: 500, pageToken } });
        for (const h of page.history || []) for (const a of h.messagesAdded || []) if (a.message?.id && !ids.includes(a.message.id)) ids.push(a.message.id);
        historyId = page.historyId || historyId;
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < 2000);
      return { ids, historyId };
    },
    async list(account, q, max = 100) {
      const page = await call(account, 'GET', '/messages', { query: { q, maxResults: max, labelIds: 'INBOX' } });
      return (page.messages || []).map((m) => m.id);
    },
    /** Read-only search across all mail (archived included), for the complaint history miner. */
    async search(account, q, { max = 100, pageToken } = {}) {
      const page = await call(account, 'GET', '/messages', { query: { q, maxResults: max, pageToken } });
      return { ids: (page.messages || []).map((m) => m.id), next: page.nextPageToken || null };
    },
    /** One attachment's bytes ({ data: base64url }). Read-only. */
    attachment: (account, id, attachmentId) => call(account, 'GET', `/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`),
    message: (account, id) => call(account, 'GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'full' } }),
    headers: (account, id, names) => call(account, 'GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'metadata', metadataHeaders: names } }),
    // A message with files goes through Gmail's upload address, which takes up to 35 MB; the
    // ordinary one is for small messages. Both keep the email in its Gmail thread.
    async send(account, { raw, threadId, large = false }) {
      if (!large && raw.length < LARGE_FROM) return call(account, 'POST', '/messages/send', { scope: GMAIL_SEND_SCOPE, body: { raw: toBase64Url(raw), ...(threadId ? { threadId } : {}) } });
      const boundary = `up-${randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),
        Buffer.from(raw, 'utf8'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await fetchImpl(`${UPLOAD}/${encodeURIComponent(account)}/messages/send?uploadType=multipart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token(account, GMAIL_SEND_SCOPE)}`, accept: 'application/json', 'content-type': `multipart/related; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (res.status === 401) tokens.delete(`${auth.serviceAccount ? account : '*'}|${GMAIL_SEND_SCOPE}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new GmailError(res.status, `Gmail ${res.status}: ${data.error?.message || res.statusText || 'request failed'}`);
      return data;
    },
  };
}

export const threadKey = (account, threadId) => (threadId ? `gmail:${account}:${threadId}` : null);
const parseThreadKey = (key) => {
  const m = /^gmail:([^:]+):(.+)$/.exec(key || '');
  return m ? { account: m[1], threadId: m[2] } : null;
};

/**
 * The outbound email connector (see channels.js for the shape).
 * message: { from, to, subject, body, thread: { key, inReplyTo, references } }
 * returns: { id, thread_key, message_id }
 */
export function createGmailConnector({ client, mailboxes, fromName = null }) {
  const { sendAs } = mailboxes;
  return {
    name: 'gmail',
    identities: [...sendAs.keys()],
    async send(message) {
      const from = normalizeEmail(message.from);
      const account = from && sendAs.get(from);
      if (!account) throw new Error(`${message.from || 'That address'} isn't connected to Gmail. Send from ${[...sendAs.keys()].join(', ')}.`);
      const thread = message.thread || {};
      const existing = parseThreadKey(thread.key);
      const files = message.attachments || [];
      // The sender name from Support settings when one is set, else EMAIL_FROM_NAME.
      const name = (message.fromName || '').trim() || fromName;
      const { raw, messageId } = buildMessage({ from, fromName: name, to: message.to, cc: message.cc || [], subject: message.subject, body: message.body, html: message.html || null, attachments: files, inReplyTo: thread.inReplyTo, references: thread.references });
      const sent = await client.send(account, { raw, threadId: existing?.account === account ? existing.threadId : null, large: files.length > 0 });
      // Gmail can replace our Message-ID; read back the one the customer will reply to.
      let finalId = messageId;
      try {
        const meta = await client.headers(account, sent.id, ['Message-ID']);
        finalId = meta.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value || messageId;
      } catch {
        // keep ours
      }
      return { id: sent.id, thread_key: threadKey(account, sent.threadId), message_id: finalId, mailbox: account };
    },
    /**
     * One file from an email, received or sent: { filename, type, data: Buffer }. Read from
     * Gmail when an agent asks for it; the portal keeps no copy.
     */
    async attachment({ mailbox, gmailId, index }) {
      const parts = attachmentParts(await client.message(mailbox, gmailId));
      const part = parts[index];
      if (!part) throw new GmailError(404, 'That file is no longer on the email in Gmail');
      const data = part.attachmentId ? Buffer.from((await client.attachment(mailbox, gmailId, part.attachmentId)).data || '', 'base64url') : Buffer.from(part.data || '', 'base64url');
      return { filename: part.filename, type: part.type, data };
    },
  };
}
