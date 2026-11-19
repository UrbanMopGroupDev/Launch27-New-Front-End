// Twilio REST client for business SMS, server-side only. Basic auth with the Account SID and
// Auth Token, or an API key (preferred for the REST calls); the Auth Token is always needed to
// check Twilio's webhook signatures. No SDK: plain fetch.
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.twilio.com';
const TIMEOUT_MS = 20_000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export class TwilioError extends Error {
  constructor(status, message, { code = null, retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code; // Twilio error code, e.g. 21610 (recipient opted out), 20429 (too many requests)
    this.retryAfter = retryAfter;
  }
}

/**
 * Twilio's webhook signature: base64(HMAC-SHA1(authToken, url + each POST param name+value,
 * sorted by name)). url is the full public URL Twilio called, including any query string.
 */
export function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + (Array.isArray(params[k]) ? params[k].join('') : params[k] ?? ''), url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validTwilioSignature(authToken, url, params, header) {
  if (!authToken || !header) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(String(header));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Twilio message status -> our delivery_state. */
export function twilioState(status) {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'failed':
    case 'undelivered':
    case 'canceled':
      return 'failed';
    default:
      return 'queued'; // queued, accepted, scheduled, sending
  }
}

export function createTwilioClient({ accountSid, authToken, apiKeySid = null, apiKeySecret = null, base = API, fetchImpl = fetch, sleep = sleepMs }) {
  const auth = `Basic ${Buffer.from(apiKeySid && apiKeySecret ? `${apiKeySid}:${apiKeySecret}` : `${accountSid}:${authToken}`).toString('base64')}`;
  const root = `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;

  // GETs retry on 429, 5xx and network errors. A send (POST) only retries on 429, which Twilio
  // returns before accepting the message: anything else might already have reached the phone.
  async function call(method, path, { query, form, maxRetries = 3 } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString()}` : '';
    const url = path.startsWith('http') ? path : `${base}${path}${qs}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { authorization: auth, accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
          body: form ? new URLSearchParams(Object.entries(form).filter(([, v]) => v != null)).toString() : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (method === 'GET' && attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new TwilioError(0, `Could not reach Twilio: ${err.message}`);
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      const retryAfter = Number(res.headers?.get?.('retry-after')) || null;
      const err = new TwilioError(res.status, `Twilio ${res.status}${data.code ? ` (${data.code})` : ''}: ${data.message || res.statusText || 'request failed'}`, { code: data.code || null, retryAfter });
      const retryable = res.status === 429 || (method === 'GET' && res.status >= 500);
      if (retryable && attempt < maxRetries) {
        await sleep(res.status === 429 ? Math.min(60, retryAfter || 2) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }

  async function pages(first, key, max = 5000) {
    const out = [];
    let next = first;
    for (let i = 0; next && i < 50 && out.length < max; i++) {
      const page = await call('GET', next);
      out.push(...(page[key] || []));
      next = page.next_page_uri ? `${base}${page.next_page_uri}` : null;
    }
    return out;
  }

  return {
    account: () => call('GET', `${root}.json`),
    /** The account's phone numbers with capabilities and where each sends incoming texts. */
    incomingNumbers: () => pages(`${base}${root}/IncomingPhoneNumbers.json?PageSize=1000`, 'incoming_phone_numbers'),
    sendSms: ({ from, to, body, statusCallback }) => call('POST', `${root}/Messages.json`, { form: { From: from, To: to, Body: body, StatusCallback: statusCallback || undefined }, maxRetries: 2 }),
    message: (sid) => call('GET', `${root}/Messages/${encodeURIComponent(sid)}.json`),
    /** Inbound texts to one of our numbers since a time (Twilio filters by day; we filter by time). */
    async inboundTo(to, since) {
      const day = new Date(since).toISOString().slice(0, 10);
      const list = await pages(`${base}${root}/Messages.json?${new URLSearchParams({ To: to, 'DateSent>': day, PageSize: '100' })}`, 'messages');
      return list.filter((m) => m.direction === 'inbound' && new Date(m.date_created || m.date_sent).getTime() >= new Date(since).getTime()).sort((a, b) => new Date(a.date_created) - new Date(b.date_created));
    },
  };
}
