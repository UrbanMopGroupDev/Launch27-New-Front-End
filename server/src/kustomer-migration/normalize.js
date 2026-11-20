// Reading Kustomer's JSON:API records into the fields the migration needs. Field names follow
// what the complaint engine already reads from this account (emails[].email, phones[].phone,
// direction, channel, preview/body) and Kustomer's usual names elsewhere; each field accepts a
// few spellings, and the full record is always kept (encrypted), so nothing is lost if a name
// differs. Messages where only a preview was available are flagged.
import { normalizeEmail, normalizePhone } from '../inbox/normalize.js';

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const ids = (rel) => (Array.isArray(rel?.data) ? rel.data : rel?.data ? [rel.data] : []).map((d) => String(d.id)).filter(Boolean);
const iso = (v) => {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const stripHtml = (html) =>
  String(html || '')
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export function customer(rec) {
  const a = rec.attributes || {};
  const emails = (a.emails || []).map((e, i) => ({ email: normalizeEmail(e.email), type: e.type || null, primary: i === 0, verified: e.verified ?? null })).filter((e) => e.email);
  if (a.email && !emails.some((e) => e.email === normalizeEmail(a.email))) emails.unshift({ email: normalizeEmail(a.email), type: 'primary', primary: true, verified: null });
  return {
    id: String(rec.id),
    name: first(a.name, a.displayName, [a.firstName, a.lastName].filter(Boolean).join(' ')) || null,
    emails: emails.filter((e) => e.email),
    phones: [...new Set((a.phones || []).map((p) => normalizePhone(p.phone)).filter(Boolean))],
    external_id: a.externalId || null,
    created_at: iso(a.createdAt),
    updated_at: iso(first(a.updatedAt, a.modifiedAt)),
  };
}

export function conversation(rec) {
  const a = rec.attributes || {};
  const r = rec.relationships || {};
  return {
    id: String(rec.id),
    customer_id: ids(r.customer)[0] || null,
    subject: first(a.name, a.subject, a.preview) || null,
    status: a.status || null,
    channels: a.channels || (a.channel ? [a.channel] : []),
    tags: ids(r.tags).length ? ids(r.tags) : a.tags || [],
    priority: a.priority ?? null,
    assigned_users: ids(r.assignedUsers),
    assigned_teams: ids(r.assignedTeams),
    queue: ids(r.queue)[0] || null,
    created_at: iso(a.createdAt),
    updated_at: iso(first(a.updatedAt, a.modifiedAt)),
    ended_at: iso(first(a.endedAt, a.lastDone?.createdAt, a.lastDoneAt)),
    message_count: a.messageCount ?? null,
    note_count: a.noteCount ?? null,
  };
}

export function message(rec) {
  const a = rec.attributes || {};
  const r = rec.relationships || {};
  const meta = a.meta || {};
  const full = first(a.body, meta.body, meta.text, meta.html ? stripHtml(meta.html) : undefined, a.html ? stripHtml(a.html) : undefined);
  const channel = String(first(a.channel, a.app) || 'unknown').toLowerCase();
  const direction = /out/i.test(String(a.direction || '')) ? 'out' : /in/i.test(String(a.direction || '')) ? 'in' : null;
  const addr = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (typeof x === 'object' ? first(x.email, x.phone, x.address) : x)).filter(Boolean);
  return {
    id: String(rec.id),
    conversation_id: ids(r.conversation)[0] || null,
    customer_id: ids(r.customer)[0] || null,
    channel: channel === 'text' ? 'sms' : channel,
    direction,
    subject: first(a.subject, meta.subject) || null,
    body: full ?? a.preview ?? '',
    preview_only: full == null && !!a.preview,
    from: addr(first(meta.from, a.from))[0] || null,
    to: addr(first(meta.to, a.to)),
    // The email's own Message-ID, when Kustomer kept it: lets us spot mail the live inbox already has.
    email_message_id: first(meta.messageId, meta.message_id, meta.headers?.['message-id'], meta.headers?.['Message-ID']) || null,
    status: a.status || null,
    sent_at: iso(first(a.sentAt, a.createdAt)),
    created_at: iso(a.createdAt),
    created_by: ids(r.createdBy)[0] || null,
    attachments: ids(r.attachments),
  };
}

export function note(rec) {
  const a = rec.attributes || {};
  const r = rec.relationships || {};
  return {
    id: String(rec.id),
    conversation_id: ids(r.conversation)[0] || null,
    body: first(a.body, a.text, a.html ? stripHtml(a.html) : undefined) || '',
    created_at: iso(a.createdAt),
    created_by: ids(r.createdBy)[0] || null,
  };
}

export function attachment(rec) {
  const a = rec.attributes || {};
  return {
    id: String(rec.id),
    name: first(a.name, a.filename) || null,
    content_type: first(a.contentType, a.mimeType) || null,
    size: first(a.contentLength, a.size) ?? null,
    // The original reference (a Kustomer URL); the file itself isn't copied.
    url: first(rec.links?.self, a.url, a.downloadUrl) || null,
  };
}
