// RingCentral REST client for business SMS, server-side only. Signs in with a JWT credential
// (a "private app" with JWT auth in the RingCentral developer console), keeps the access token
// in memory and signs in again when it expires or RingCentral rejects it. No SDK: plain fetch.
//
// The calling widget in the browser (RingCentral Embeddable, RINGCENTRAL_CLIENT_ID) is separate
// and unchanged: agents still sign in to it themselves.
const TIMEOUT_MS = 20_000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Permissions the app needs (app "scopes" in the developer console).
export const REQUIRED_SCOPES = ['SMS', 'ReadMessages', 'ReadAccounts', 'WebhookSubscriptions'];
// The message-store event for incoming texts on the signed-in extension.
export const SMS_EVENT_FILTER = '/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS';

export class RingCentralError extends Error {
  constructor(status, message, { code = null, retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code; // RingCentral errorCode, e.g. CMN-301 (rate limit), OAU-251 (bad JWT)
    this.retryAfter = retryAfter; // seconds
  }
}

export function createRingCentralClient({ server, clientId, clientSecret, jwt, fetchImpl = fetch, now = () => Date.now(), sleep = sleepMs }) {
  const base = String(server).replace(/\/+$/, '');
  let token = null; // { value, exp, scope }

  async function signIn() {
    const res = await fetchImpl(`${base}/restapi/oauth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      token = null;
      // Never echo the credential; RingCentral's own description is safe to show.
      throw new RingCentralError(res.status, `RingCentral sign-in failed: ${body.error_description || body.message || body.error || res.status}`, { code: body.errors?.[0]?.errorCode || body.error || null });
    }
    token = { value: body.access_token, exp: now() + (Number(body.expires_in) || 3600) * 1000 - 60_000, scope: String(body.scope || '').split(/\s+/).filter(Boolean) };
    return token;
  }

  async function accessToken() {
    if (token && token.exp > now()) return token.value;
    return (await signIn()).value;
  }

  // One call. 401 signs in again once (expired or revoked token). 429 and, for reads, 5xx and
  // timeouts are retried with backoff. A send (POST /sms) is never retried after RingCentral
  // may have accepted it: only a 429, which means it was refused, is retried.
  async function call(method, path, { query, body, retryUnsafe = false, maxRetries = 3 } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString()}` : '';
    for (let attempt = 0, reauthed = false; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${base}/restapi/v1.0${path}${qs}`, {
          method,
          headers: { authorization: `Bearer ${await accessToken()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof RingCentralError) throw err; // sign-in failed
        if ((method === 'GET' || retryUnsafe) && attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new RingCentralError(0, `Could not reach RingCentral: ${err.message}`);
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      const retryAfter = Number(res.headers?.get?.('retry-after')) || Number(res.headers?.get?.('x-rate-limit-window')) || null;
      const err = new RingCentralError(res.status, `RingCentral ${res.status}: ${data.message || data.errors?.[0]?.message || res.statusText || 'request failed'}`, { code: data.errorCode || data.errors?.[0]?.errorCode || null, retryAfter });
      if (res.status === 401 && !reauthed) {
        token = null;
        reauthed = true;
        attempt--;
        continue;
      }
      const retryable = res.status === 429 || ((method === 'GET' || retryUnsafe) && res.status >= 500);
      if (retryable && attempt < maxRetries) {
        const wait = res.status === 429 ? Math.min(60, retryAfter || 5) * 1000 : 1000 * 2 ** attempt;
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  return {
    signIn,
    scopes: () => token?.scope || [],
    /** The extension the JWT belongs to: id, number, name, account. */
    extension: () => call('GET', '/account/~/extension/~'),
    /** Phone numbers of that extension, with features (SmsSender, ...). */
    async phoneNumbers() {
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const r = await call('GET', '/account/~/extension/~/phone-number', { query: { perPage: 100, page } });
        out.push(...(r.records || []));
        if (!r.navigation?.nextPage) break;
      }
      return out;
    },
    /** Send one SMS. A 429 is retried (it was refused); anything else is not. */
    sendSms: ({ from, to, text }) => call('POST', '/account/~/extension/~/sms', { body: { from: { phoneNumber: from }, to: [{ phoneNumber: to }], text }, maxRetries: 2 }),
    message: (id) => call('GET', `/account/~/extension/~/message-store/${encodeURIComponent(id)}`),
    /** Inbound SMS since a time, oldest first, following every page. */
    async inboundSince(dateFrom, { max = 1000 } = {}) {
      const out = [];
      for (let page = 1; page <= 50 && out.length < max; page++) {
        const r = await call('GET', '/account/~/extension/~/message-store', { query: { messageType: 'SMS', direction: 'Inbound', dateFrom, perPage: 100, page } });
        out.push(...(r.records || []));
        if (!r.navigation?.nextPage) break;
      }
      return out.sort((a, b) => String(a.creationTime).localeCompare(String(b.creationTime)));
    },
    createSubscription: ({ address, verificationToken, expiresIn = 604_800 }) =>
      call('POST', '/subscription', { body: { eventFilters: [SMS_EVENT_FILTER], deliveryMode: { transportType: 'WebHook', address, verificationToken }, expiresIn }, retryUnsafe: false }),
    renewSubscription: (id) => call('POST', `/subscription/${encodeURIComponent(id)}/renew`),
    subscription: (id) => call('GET', `/subscription/${encodeURIComponent(id)}`),
    deleteSubscription: (id) => call('DELETE', `/subscription/${encodeURIComponent(id)}`),
  };
}

/** RingCentral message status -> our delivery_state. */
export function deliveryState(messageStatus) {
  switch (messageStatus) {
    case 'Queued':
      return 'queued';
    case 'Sent':
      return 'sent';
    case 'Delivered':
      return 'delivered';
    case 'DeliveryFailed':
    case 'SendingFailed':
      return 'failed';
    default:
      return 'queued';
  }
}
