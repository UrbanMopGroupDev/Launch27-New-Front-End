// Reading Kustomer for the migration: GET requests only (through the complaint engine's
// read-only client, which already retries 429s and 5xx with backoff), paced to a request rate
// so the export never competes with day-to-day Kustomer use.

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const PAGE = { page: 1, pageSize: 100 };

export function createKustomerSource(client, { rpm = 300, sleep = sleepMs, now = () => Date.now(), maxPages = 2000 } = {}) {
  const gap = Math.max(0, Math.floor(60_000 / Math.max(1, rpm)));
  let nextAt = 0;
  let requests = 0;

  async function get(pathOrLink, query) {
    const wait = nextAt - now();
    if (wait > 0) await sleep(wait);
    nextAt = Math.max(now(), nextAt) + gap;
    requests++;
    return client.get(pathOrLink, query);
  }

  /** Every record of a JSON:API list, following links.next. */
  async function all(path, query = PAGE) {
    const out = [];
    let body = await get(path, query);
    for (let page = 1; page <= maxPages; page++) {
      const data = Array.isArray(body?.data) ? body.data : [];
      out.push(...data);
      const next = body?.links?.next;
      if (!next || !data.length) break;
      body = await get(next);
    }
    return out;
  }

  async function check(name, fn) {
    try {
      return { result: await fn(), row: { name, ok: true } };
    } catch (err) {
      const denied = err.status === 401 || err.status === 403;
      return { result: null, row: { name, ok: false, status: err.status || null, error: String(err.message).slice(0, 300), hint: denied ? 'The API key is missing a read role for this (see docs/kustomer-migration.md).' : null } };
    }
  }

  return {
    requests: () => requests,
    /** One page of the customer list; pass the previous page's next link to continue. */
    async customersPage(link) {
      const body = link ? await get(link) : await get('/v1/customers', PAGE);
      return { records: Array.isArray(body?.data) ? body.data : [], next: body?.links?.next || null, meta: body?.meta || null };
    },
    customer: async (id) => (await get(`/v1/customers/${enc(id)}`))?.data || null,
    conversations: (customerId) => all(`/v1/customers/${enc(customerId)}/conversations`),
    messages: (conversationId) => all(`/v1/conversations/${enc(conversationId)}/messages`),
    notes: (conversationId) => all(`/v1/conversations/${enc(conversationId)}/notes`),
    attachment: async (id) => (await get(`/v1/attachments/${enc(id)}`))?.data || null,

    /**
     * Which endpoints the export uses this key can read, tried on the first customer that has
     * a conversation. Each is reported as ok, or with the reason (a 403 means a missing role).
     */
    async testConnection() {
      const rows = [];
      const list = await check('List customers', async () => {
        const body = await get('/v1/customers', { page: 1, pageSize: 25 });
        return { records: body?.data || [], meta: body?.meta || null, next: body?.links?.next || null };
      });
      rows.push(list.row);
      let conv = null;
      let convRow = null;
      for (const c of (list.result?.records || []).slice(0, 25)) {
        const r = await check('Customer conversations', () => get(`/v1/customers/${enc(c.id)}/conversations`, { page: 1, pageSize: 5 }).then((b) => b?.data || []));
        convRow = r.row;
        if (!r.result) break; // refused: no point trying more customers
        if (r.result.length) {
          conv = r.result[0];
          break;
        }
      }
      if (convRow) rows.push(convRow);
      if (conv) {
        const msgs = await check('Conversation messages', () => get(`/v1/conversations/${enc(conv.id)}/messages`, { page: 1, pageSize: 25 }).then((b) => b?.data || []));
        rows.push(msgs.row);
        rows.push((await check('Conversation notes', () => get(`/v1/conversations/${enc(conv.id)}/notes`, { page: 1, pageSize: 5 }))).row);
        const att = (msgs.result || []).flatMap((m) => m.relationships?.attachments?.data || [])[0];
        if (att) rows.push((await check('Attachment details', () => get(`/v1/attachments/${enc(att.id)}`))).row);
      }
      const meta = list.result?.meta || {};
      return {
        ok: rows.every((r) => r.ok),
        checks: rows,
        sample: { customers_on_first_page: list.result?.records?.length ?? 0, more_pages: !!list.result?.next, total_reported: meta.totalCount ?? meta.total ?? null },
      };
    },
  };
}
