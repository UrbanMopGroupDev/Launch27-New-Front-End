// Kustomer source connector (read-only). Kustomer is being replaced by the Ops inbox, so
// this connector only reads complaint objects and their conversations into our own tables;
// nothing is written back and nothing downstream depends on Kustomer.
//
// Field names on the complaint object are set up per org in Kustomer, so they are NOT
// hard-coded: discover() lists the klasses and the complaint klass's custom field names
// (names and types only, no values), and toCase() maps them by name pattern. Anything a
// pattern misses still lands in complaint_cases.raw, so nothing is lost for the migration.
//
// Only GET requests. KUSTOMER_API_KEY must be a key with read-only roles.

const BASE = 'https://api.kustomerapp.com';

export class KustomerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createKustomerClient({ apiKey, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), baseUrl = BASE }) {
  async function get(path, query = {}) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${baseUrl}${path}${qs ? `?${qs}` : ''}`, { method: 'GET', headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 && attempt < 5) {
        await sleep(Math.min(60, Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new KustomerError(res.status, `Kustomer ${path.replace(/\/[0-9a-f]{24}/g, '/:id')} returned ${res.status}`);
      return res.json();
    }
  }
  // JSON:API pages: { data: [...], links: { next } }. Stops at maxPages.
  async function* pages(path, query = {}, maxPages = 500) {
    for (let page = 1; page <= maxPages; page++) {
      const body = await get(path, { ...query, page, pageSize: 100 });
      const data = Array.isArray(body.data) ? body.data : [];
      yield { data, included: body.included || [] };
      if (!data.length || !body.links?.next) return;
    }
  }
  return { get, pages };
}

const typeOf = (v) => (v == null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Which klasses exist, which one is the complaint, and its field names/types. No values. */
export async function discover(client, { klass = null } = {}) {
  const klasses = (await client.get('/v1/klasses')).data || [];
  const names = klasses.map((k) => ({ name: k.attributes?.name || k.id, display: k.attributes?.displayName || null }));
  const chosen = klass || names.find((k) => /complain/i.test(`${k.name} ${k.display || ''}`))?.name || null;
  let fields = null;
  let sampleCount = 0;
  if (chosen) {
    const body = await client.get(`/v1/klasses/${encodeURIComponent(chosen)}/kobjects`, { page: 1, pageSize: 25 });
    const shape = new Map();
    for (const o of body.data || []) {
      sampleCount++;
      for (const [k, v] of Object.entries(o.attributes?.custom || {})) shape.set(`custom.${k}`, typeOf(v));
      for (const [k, v] of Object.entries(o.attributes || {})) if (k !== 'custom') shape.set(k, typeOf(v));
      for (const k of Object.keys(o.relationships || {})) shape.set(`relationships.${k}`, 'relationship');
    }
    fields = [...shape].map(([name, type]) => ({ name, type }));
  }
  return { klasses: names, complaint_klass: chosen, fields, sample_count: sampleCount };
}

// Field-name patterns for the complaint object's custom fields (first match wins).
const PICK = {
  status: /(^|_)status/i,
  category: /(categor|type|reason|issue)/i,
  booking: /(booking|job|appointment).*(id|num|#)?/i,
  service_date: /(service|clean|appointment|booking).*(date|at)$/i,
  cleaner: /(cleaner|team|staff|maid)/i,
  resolution: /(resolution|outcome|offer|remedy|action)/i,
  amount: /(amount|refund|credit|cost|value)/i,
  description: /(description|details|notes?|summary|body|comment)/i,
};
const findField = (custom, re) => Object.keys(custom).find((k) => re.test(k));

// Kustomer complaint statuses → ours (raw value is kept in source_status).
export function mapStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (/reclean/.test(s)) return 'reclean_scheduled';
  if (/awaiting|waiting|pending/.test(s)) return 'awaiting_client';
  if (/resolved|closed|done|complete/.test(s)) return 'resolved';
  return 'open'; // For Review, Damaged Item, new…
}

export function toCase(kobject) {
  const a = kobject.attributes || {};
  const custom = a.custom || {};
  const val = (key) => (key ? custom[key] : undefined);
  const f = Object.fromEntries(Object.entries(PICK).map(([k, re]) => [k, findField(custom, re)]));
  const statusRaw = val(f.status) ?? a.status ?? null;
  const bookingRaw = val(f.booking);
  const bookingId = Number(String(bookingRaw ?? '').replace(/\D/g, '')) || null;
  const amount = Number(String(val(f.amount) ?? '').replace(/[^0-9.]/g, '')) || null;
  const rel = kobject.relationships || {};
  return {
    source: 'kustomer',
    source_id: String(kobject.id),
    kustomer_customer_id: rel.customer?.data?.id || null,
    kustomer_conversation_ids: [rel.conversation?.data?.id, ...(rel.conversations?.data || []).map((c) => c.id)].filter(Boolean),
    opened_at: a.createdAt || null,
    resolved_at: mapStatus(statusRaw) === 'resolved' ? a.updatedAt || null : null,
    status: mapStatus(statusRaw),
    source_status: statusRaw == null ? null : String(statusRaw),
    source_category: val(f.category) ?? null,
    l27_booking_id: bookingId,
    service_date: val(f.service_date) ? String(val(f.service_date)).slice(0, 10) : null,
    cleaner_text: val(f.cleaner) ?? null,
    resolution_text: val(f.resolution) ?? null,
    claim_amount: amount,
    text: [a.title, a.description, val(f.description), val(f.category), val(f.resolution)].filter((x) => typeof x === 'string' && x.trim()).join('\n'),
    raw: { title: a.title || null, custom, createdAt: a.createdAt, updatedAt: a.updatedAt, klass: a.klass || null },
    field_map: f,
  };
}

/** Complaint kobjects created in [from, to]. Kustomer returns newest first by default. */
export async function* listComplaints(client, klass, { from, to }) {
  for await (const { data } of client.pages(`/v1/klasses/${encodeURIComponent(klass)}/kobjects`, { sort: '-createdAt' })) {
    let older = 0;
    for (const o of data) {
      const at = o.attributes?.createdAt;
      if (at && at < from) {
        older++;
        continue;
      }
      if (at && at > `${to}T23:59:59Z`) continue;
      yield o;
    }
    // A whole page older than the window: the rest is older too (sorted newest first).
    if (data.length && older === data.length) return;
  }
}

export async function customer(client, id) {
  const c = (await client.get(`/v1/customers/${encodeURIComponent(id)}`)).data || {};
  const a = c.attributes || {};
  return {
    name: a.name || [a.firstName, a.lastName].filter(Boolean).join(' ') || null,
    emails: (a.emails || []).map((e) => e.email).filter(Boolean),
    phones: (a.phones || []).map((p) => p.phone).filter(Boolean),
    external_id: a.externalId || null,
  };
}

/** The customer's conversations around the complaint, with their messages (text only). */
export async function conversationsAround(client, customerId, at, { daysBefore = 14, daysAfter = 30, ids = [] } = {}) {
  const lo = new Date(Date.parse(at) - daysBefore * 86_400_000).toISOString();
  const hi = new Date(Date.parse(at) + daysAfter * 86_400_000).toISOString();
  const convs = [];
  for await (const { data } of client.pages(`/v1/customers/${encodeURIComponent(customerId)}/conversations`, {}, 10)) {
    for (const c of data) {
      const created = c.attributes?.createdAt;
      if (ids.includes(c.id) || (created && created >= lo && created <= hi)) convs.push(c);
    }
  }
  const out = [];
  for (const c of convs.slice(0, 10)) {
    const msgs = [];
    for await (const { data } of client.pages(`/v1/conversations/${encodeURIComponent(c.id)}/messages`, {}, 5)) {
      for (const m of data) {
        const a = m.attributes || {};
        msgs.push({ id: m.id, direction: a.direction || null, channel: a.channel || null, at: a.createdAt || null, text: a.preview || a.body || '', sender: a.direction === 'out' ? m.relationships?.createdBy?.data?.id || 'agent' : 'customer' });
      }
    }
    msgs.sort((x, y) => String(x.at).localeCompare(String(y.at)));
    out.push({ id: c.id, channel: c.attributes?.channels?.[0] || null, status: c.attributes?.status || null, created_at: c.attributes?.createdAt || null, messages: msgs });
  }
  return out;
}
