// Complaints tracker: the office's complaint cases, moved here from Kustomer like for like
// (docs/complaint-tracker.md). One record per complaint, Kustomer's saved searches as views,
// an internal comments thread, and a one-way load of recent complaints from Kustomer
// (GET only, through the existing connector). The Complaint Resolution Engine
// (src/complaints, complaint_cases) is separate and is not read or changed here.
import { createKustomerClient, discover } from '../complaints/sources/kustomer.js';
import { audit } from '../inbox/service.js';
import { CLOSE_FIELDS, FIELDS, FIELD_KEYS, LIST_COLUMNS, PANELS, STATUSES, TYPE_TO_PLAYBOOK, USER_LINKS, VIEWS, cleanValue, missingToClose } from './fields.js';
import { categoryLabel, causeLabel, causeRules, classifyRules, HARD_ROUTES } from '../complaints/taxonomy.js';

const one = async (q, sql, p) => (await q.query(sql, p)).rows[0] || null;
const many = async (q, sql, p) => (await q.query(sql, p)).rows;
const fail = (status, message) => Object.assign(new Error(message), { status });
const TZ = 'America/Toronto';

/** The calendar day in Toronto of an instant (Kustomer stores dates as Toronto midnight in UTC). */
export function torontoDay(value) {
  const t = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

// Every column the API returns, with dates as YYYY-MM-DD text and numbers as numbers.
const FIELD_SQL = FIELDS.map((f) => (f.type === 'date' ? `r.${f.key}::text AS ${f.key}` : f.type === 'number' ? `r.${f.key}::float8 AS ${f.key}` : `r.${f.key}`)).join(', ');
const BASE_SQL = `r.id, r.source, r.source_id, r.title, r.state, r.snooze_until, r.conversation_id, r.contact_id, r.l27_customer_id, r.l27_booking_id,
  r.cleaner_id, ${USER_LINKS.map((l) => `r.${l.id}`).join(', ')}, r.assigned_user_id, r.created_by, r.created_at, r.updated_at, ${FIELD_SQL},
  COALESCE(u.name, u.email) AS assigned_user,
  (SELECT count(*)::int FROM complaint_record_comments cm WHERE cm.record_id = r.id) AS comment_count`;

const SORTS = {
  created_at: 'r.created_at',
  title: 'lower(r.title)',
  status: 'lower(r.status)',
  customer_name: 'lower(r.customer_name)',
  ltv_of_client: 'r.ltv_of_client',
  due_date: 'r.due_date',
  cleaner_name: 'lower(r.cleaner_name)',
  assigned_user: 'lower(COALESCE(u.name, u.email))',
  case_opened_by: 'lower(r.case_opened_by)',
  original_service_date: 'r.original_service_date',
  proposed_solution: 'lower(r.proposed_solution)',
  complaint_notes: 'lower(r.complaint_notes)',
  input_into_um_portal: 'r.input_into_um_portal',
  tier_level: 'r.tier_level',
  rating_days_left: 'rating_days_left',
};

/** A Kustomer complaint object -> the columns of a complaint record (values as Kustomer has them). */
export function fromKustomer(kobject) {
  const a = kobject.attributes || {};
  const custom = a.custom || {};
  const rel = kobject.relationships || {};
  const out = {};
  for (const f of FIELDS) {
    const v = custom[f.k];
    if (v === null || v === undefined || v === '') out[f.key] = null;
    else if (f.type === 'date') out[f.key] = torontoDay(v);
    else if (f.type === 'number') {
      const n = Number(String(v).replace(/[$,\s]/g, ''));
      out[f.key] = Number.isFinite(n) ? n : null;
    } else out[f.key] = f.type === 'long' ? String(v) : String(v).trim();
  }
  const state = a.status === 'done' ? 'done' : a.status === 'snoozed' && a.snooze?.time ? 'snoozed' : 'open';
  return {
    source_id: String(kobject.id),
    title: String(a.title || 'Complaint').slice(0, 500),
    state,
    snooze_until: state === 'snoozed' ? a.snooze.time : null,
    created_at: a.createdAt || null,
    fields: out,
    source_meta: {
      customer: rel.customer?.data?.id || null,
      conversation: rel.conversation?.data?.id || null,
      assigned_user: (typeof a.assignedUser === 'string' ? a.assignedUser : a.assignedUser?.id) || rel.assignedUser?.data?.id || null,
      created_by: rel.createdBy?.data?.id || null,
      comment_count: a.commentCount || 0,
      updated_at: a.updatedAt || null,
      custom,
    },
  };
}

// Kustomer escapes punctuation in comment text ("bi\-weekly"); show it as typed.
const unescapeComment = (s) => String(s || '').replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');

// A Launch27 cleaner's name as the office writes it: the title without its leading codes
// ("(OTT) Maria Gonzalez" -> "Maria Gonzalez"), as the conversation's Cleaner picker shows it.
export const cleanerTitle = (t) => {
  const title = String(t?.title || '').trim();
  const stripped = title.replace(/^\s*(on\s*hold\s*)?(\s*\([^)]*\))*\s*/i, '').trim();
  return stripped || title || [t?.first_name, t?.last_name].filter(Boolean).join(' ').trim() || null;
};
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Launch27 cleaners -> Map(name key -> { id, name }), only names that belong to one cleaner. */
export function cleanerIndex(teams) {
  const seen = new Map();
  for (const t of teams || []) {
    const id = Number(t?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const name = cleanerTitle(t);
    const keys = new Set([nameKey(name), nameKey([t.first_name, t.last_name].filter(Boolean).join(' '))].filter(Boolean));
    for (const k of keys) {
      const prev = seen.get(k);
      seen.set(k, prev && prev.id !== id ? { ambiguous: true } : { id, name });
    }
  }
  for (const [k, v] of seen) if (v.ambiguous) seen.delete(k);
  return seen;
}

export function createTracker({ db, config, fetchImpl = fetch, log = { info() {}, warn() {}, error() {} }, now = () => Date.now(), complaints = null }) {
  const ratingDays = Number(config.ratingLinkDays) > 0 ? Number(config.ratingLinkDays) : 5;
  const today = () => torontoDay(now());
  // Days until the booking's Launch27 rating link stops working (service date + the window).
  const daysLeftSql = (pToday) => `(r.original_service_date + ${ratingDays} - $${pToday}::date)`;
  let load = { running: false, started_at: null, finished_at: null, result: null, error: null };

  const wake = () => db.query("UPDATE complaint_records SET state = 'open', snooze_until = NULL WHERE state = 'snoozed' AND snooze_until <= now()");
  const view = (slug) => VIEWS.find((v) => v.slug === slug) || null;

  async function meta() {
    const users = await many(db, 'SELECT id, name, email FROM users WHERE active ORDER BY lower(COALESCE(name, email))');
    return {
      fields: FIELDS.map(({ k: _k, ...f }) => f),
      panels: PANELS,
      statuses: STATUSES,
      views: VIEWS.map((v) => ({ slug: v.slug, name: v.name, kind: v.kind || 'complaints' })),
      columns: LIST_COLUMNS,
      rating_days: ratingDays,
      users,
      kustomer: config.kustomerApiKey ? 'connected' : 'not connected',
      close_fields: CLOSE_FIELDS,
      playbook: !!complaints,
    };
  }

  async function counts() {
    await wake();
    const parts = VIEWS.filter((v) => v.where).map((v) => `count(*) FILTER (WHERE ${v.where})::int AS "${v.slug}"`);
    const row = await one(db, `SELECT ${parts.join(', ')}, count(*)::int AS "all" FROM complaint_records r`);
    const positive = await one(db, 'SELECT count(*)::int AS n FROM um_portal_feedback WHERE done_at IS NULL');
    return { ...row, 'um-portal-positive': positive.n };
  }

  async function list({ view: slug = 'overview', sort = null, dir = null, q = '' } = {}) {
    await wake();
    const v = view(slug);
    if (!v || !v.where) throw fail(400, 'Unknown view');
    const key = SORTS[sort] ? sort : v.sort || 'created_at';
    const direction = dir === 'asc' || dir === 'desc' ? dir : key === 'rating_days_left' ? 'asc' : 'desc';
    const params = [today()];
    let where = v.where;
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().toLowerCase().slice(0, 100)}%`);
      where += ` AND (lower(r.title) LIKE $2 OR lower(COALESCE(r.customer_name, '')) LIKE $2 OR lower(COALESCE(r.cleaner_name, '')) LIKE $2)`;
    }
    const rows = await many(
      db,
      `SELECT ${BASE_SQL}, ${daysLeftSql(1)} AS rating_days_left
         FROM complaint_records r LEFT JOIN users u ON u.id = r.assigned_user_id
        WHERE ${where}
        ORDER BY ${SORTS[key]} ${direction} NULLS LAST, r.id DESC LIMIT 2000`,
      params,
    );
    return { view: { slug: v.slug, name: v.name }, sort: key, dir: direction, rows };
  }

  async function get(id) {
    await wake();
    const record = await one(
      db,
      `SELECT ${BASE_SQL}, ${daysLeftSql(2)} AS rating_days_left, r.source_meta->>'customer' AS kustomer_customer_id,
              co.name AS contact_name, cu.name AS created_by_name, cv.subject AS conversation_subject, cv.channel AS conversation_channel
         FROM complaint_records r
         LEFT JOIN users u ON u.id = r.assigned_user_id
         LEFT JOIN users cu ON cu.id = r.created_by
         LEFT JOIN contacts co ON co.id = r.contact_id
         LEFT JOIN conversations cv ON cv.id = r.conversation_id
        WHERE r.id = $1`,
      [id, today()],
    );
    if (!record) return null;
    const comments = await many(
      db,
      `SELECT cm.id, cm.body, cm.created_at, cm.author_id, COALESCE(a.name, a.email, cm.author_name) AS author
         FROM complaint_record_comments cm LEFT JOIN users a ON a.id = cm.author_id WHERE cm.record_id = $1 ORDER BY cm.created_at, cm.id`,
      [id],
    );
    return { record, comments };
  }

  /** Request body -> { column: value } for the complaint's own fields (only keys that were sent). */
  function fieldValues(body) {
    const out = {};
    for (const f of FIELDS) if (body[f.key] !== undefined) out[f.key] = cleanValue(f, body[f.key]);
    return out;
  }
  const idOrNull = (v, what) => {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw fail(400, `${what}: not a valid id`);
    return n;
  };

  // "Complaint" on a conversation opens the complaint already made for it, or makes one.
  async function create(user, body = {}) {
    const convId = body.conversation_id == null ? null : idOrNull(body.conversation_id, 'Conversation');
    if (convId) {
      const existing = await one(db, "SELECT id FROM complaint_records WHERE conversation_id = $1 AND state <> 'done' ORDER BY id DESC LIMIT 1", [convId]);
      if (existing) return { ...(await get(Number(existing.id))), existing: true };
    }
    const values = fieldValues(body);
    if (body.cleaner_id != null && values.cleaner_name) values.cleaner_id = idOrNull(body.cleaner_id, 'Cleaner');
    let contactId = body.contact_id == null ? null : idOrNull(body.contact_id, 'Contact');
    let l27Customer = body.l27_customer_id == null ? null : idOrNull(body.l27_customer_id, 'Customer');
    let l27Booking = body.l27_booking_id == null ? null : idOrNull(body.l27_booking_id, 'Booking');
    if (convId) {
      const conv = await one(db, 'SELECT c.id, c.contact_id, c.l27_booking_id, c.cleaner_id, c.cleaner_name, co.name AS contact_name, co.l27_customer_id FROM conversations c LEFT JOIN contacts co ON co.id = c.contact_id WHERE c.id = $1', [convId]);
      if (!conv) throw fail(404, 'Conversation not found');
      contactId ??= conv.contact_id ? Number(conv.contact_id) : null;
      l27Customer ??= conv.l27_customer_id ? Number(conv.l27_customer_id) : null;
      l27Booking ??= conv.l27_booking_id ? Number(conv.l27_booking_id) : null;
      values.customer_name ??= conv.contact_name || null;
      if (values.cleaner_name === undefined && conv.cleaner_name) {
        values.cleaner_name = conv.cleaner_name;
        if (conv.cleaner_id) values.cleaner_id = Number(conv.cleaner_id);
      }
    } else if (contactId) {
      const co = await one(db, 'SELECT name, l27_customer_id FROM contacts WHERE id = $1', [contactId]);
      if (!co) throw fail(404, 'Contact not found');
      l27Customer ??= co.l27_customer_id ? Number(co.l27_customer_id) : null;
      values.customer_name ??= co.name || null;
    }
    values.status ??= 'For Review';
    values.complaint_created_on ??= today();
    if (values.case_opened_by === undefined) {
      values.case_opened_by = user.name || user.email;
      values.case_opened_by_user_id = Number(user.id);
    }
    const title = String(body.title || '').trim().slice(0, 500) || `Complaint for ${values.customer_name || 'a client'}`;
    const cols = ['title', 'conversation_id', 'contact_id', 'l27_customer_id', 'l27_booking_id', 'created_by', ...Object.keys(values)];
    const params = [title, convId, contactId, l27Customer, l27Booking, user.id, ...Object.values(values)];
    const row = await one(db, `INSERT INTO complaint_records (${cols.join(', ')}, edited_at) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, now()) RETURNING id`, params);
    await audit(db, user.id, 'complaint.created', 'complaint_record', row.id, { conversation_id: convId });
    return { ...(await get(Number(row.id))), existing: false };
  }

  function patchValues(user, body) {
    const set = fieldValues(body);
    if (body.title !== undefined) {
      const title = String(body.title || '').trim().slice(0, 500);
      if (!title) throw fail(400, 'A complaint needs a title');
      set.title = title;
    }
    if (body.state !== undefined) {
      if (!['open', 'snoozed', 'done'].includes(body.state)) throw fail(400, 'Unknown state');
      set.state = body.state;
      if (body.state === 'snoozed') {
        const until = Date.parse(body.snooze_until);
        if (!Number.isFinite(until) || until <= now()) throw fail(400, 'Pick a time in the future to snooze until');
        set.snooze_until = new Date(until).toISOString();
      } else set.snooze_until = null;
    }
    // A name typed over a linked one is no longer that record.
    for (const f of FIELDS) if (f.id && body[f.key] !== undefined && body[f.id] === undefined) set[f.id] = null;
    if (body.cleaner_id !== undefined) {
      set.cleaner_id = idOrNull(body.cleaner_id, 'Cleaner');
      if (set.cleaner_id && !set.cleaner_name) throw fail(400, 'Cleaner: name missing');
      if (!set.cleaner_id && body.cleaner_name === undefined) set.cleaner_name = null;
    }
    for (const l of USER_LINKS) if (body[l.id] !== undefined) set[l.id] = idOrNull(body[l.id], l.key);
    if (body.contact_id !== undefined) set.contact_id = idOrNull(body.contact_id, 'Customer');
    if (body.assigned_user_id !== undefined) set.assigned_user_id = body.assigned_user_id === 'me' ? Number(user.id) : idOrNull(body.assigned_user_id, 'Assigned user');
    if (body.conversation_id !== undefined) set.conversation_id = idOrNull(body.conversation_id, 'Conversation');
    if (body.l27_booking_id !== undefined) set.l27_booking_id = idOrNull(body.l27_booking_id, 'Booking');
    return set;
  }

  async function applyPatch(q, user, id, set) {
    const before = await one(q, `SELECT id, status, closed_date, case_closed_by, assigned_user_id, ${CLOSE_FIELDS.join(', ')} FROM complaint_records WHERE id = $1`, [id]);
    if (!before) throw fail(404, 'Complaint not found');
    const values = { ...set };
    // A staff login picked for a name field: the name shown is that login's.
    for (const l of USER_LINKS) {
      if (!values[l.id]) continue;
      const u = await one(q, 'SELECT id, name, email FROM users WHERE id = $1', [values[l.id]]);
      if (!u) throw fail(400, 'That person has no login here');
      values[l.key] = u.name || u.email;
    }
    // A contact picked as the customer: their name and Launch27 customer come with them.
    if (values.contact_id) {
      const co = await one(q, 'SELECT name, l27_customer_id FROM contacts WHERE id = $1', [values.contact_id]);
      if (!co) throw fail(400, 'Customer: contact not found');
      values.customer_name = co.name || null;
      values.l27_customer_id = co.l27_customer_id || null;
    } else if (values.contact_id === null) values.l27_customer_id = null;
    // A Closed complaint carries its outcome and cost. Closing needs all of it; on a complaint
    // already Closed (older ones may have gaps), a change may fill gaps one field at a time but
    // never open a new one.
    const after = { ...before, ...values };
    if (after.status === 'Closed') {
      const missing = missingToClose(after);
      const already = before.status === 'Closed' ? new Set(missingToClose(before)) : new Set();
      const added = missing.filter((m) => !already.has(m));
      if (added.length) throw fail(400, before.status === 'Closed' ? `A closed complaint needs: ${added.join('; ')}` : `To close this complaint, fill in: ${missing.join('; ')}`);
    }
    // Kustomer stamps the closed date when the status becomes Closed; who closed it is stamped too.
    if (values.status === 'Closed' && before.status !== 'Closed') {
      if (!before.closed_date && values.closed_date === undefined) values.closed_date = today();
      if (!before.case_closed_by && values.case_closed_by === undefined) {
        values.case_closed_by = user.name || user.email;
        values.case_closed_by_user_id = Number(user.id);
      }
    }
    const keys = Object.keys(values);
    if (!keys.length) return;
    await q.query(`UPDATE complaint_records SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, edited_at = now(), updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => values[k])]);
    await audit(q, user.id, 'complaint.updated', 'complaint_record', id, { fields: keys });
    if (values.assigned_user_id && Number(values.assigned_user_id) !== Number(before.assigned_user_id) && Number(values.assigned_user_id) !== Number(user.id)) {
      await q.query("INSERT INTO notifications (user_id, kind, complaint_record_id, text) VALUES ($1, 'assigned', $2, $3)", [values.assigned_user_id, id, `${user.name || user.email} assigned you a complaint`]);
    }
  }

  async function patch(user, id, body = {}) {
    const set = patchValues(user, body);
    await db.tx((q) => applyPatch(q, user, id, set));
    return get(id);
  }

  // The list's bulk actions: the same change on every ticked complaint.
  async function bulk(user, ids, body = {}) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!list.length) throw fail(400, 'Tick at least one complaint');
    if (list.length > 500) throw fail(400, 'Too many at once (500 at most)');
    const set = patchValues(user, body);
    if (!Object.keys(set).length) throw fail(400, 'Nothing to change');
    await db.tx(async (q) => {
      for (const id of list) {
        try {
          await applyPatch(q, user, id, set);
        } catch (err) {
          if (err.status === 400) err.message = `Complaint #${id}: ${err.message}. Nothing was changed.`;
          throw err;
        }
      }
    });
    return { updated: list.length };
  }

  // Internal comment. @jane matches jane@urbanmop.ca or a user named Jane (as inbox notes do).
  async function comment(user, id, body) {
    const text = String(body || '').trim();
    if (!text) throw fail(400, 'Write a comment first');
    if (text.length > 10_000) throw fail(400, 'That comment is too long');
    return db.tx(async (q) => {
      if (!(await one(q, 'SELECT 1 FROM complaint_records WHERE id = $1', [id]))) throw fail(404, 'Complaint not found');
      const row = await one(q, 'INSERT INTO complaint_record_comments (record_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at, author_id', [id, user.id, text]);
      await q.query('UPDATE complaint_records SET updated_at = now() WHERE id = $1', [id]);
      const handles = [...new Set([...text.matchAll(/@([\w.-]+)/g)].map((m) => m[1].toLowerCase()))];
      const told = new Set();
      for (const h of handles) {
        const users = await many(q, `SELECT id FROM users WHERE lower(split_part(email,'@',1)) = $1 OR lower(replace(coalesce(name,''),' ','')) = $1 OR lower(split_part(coalesce(name,''),' ',1)) = $1`, [h]);
        for (const u of users) {
          if (Number(u.id) === Number(user.id) || told.has(Number(u.id))) continue;
          told.add(Number(u.id));
          await q.query("INSERT INTO notifications (user_id, kind, complaint_record_id, text) VALUES ($1, 'mention', $2, $3)", [u.id, id, `${user.name || user.email} mentioned you on a complaint`]);
        }
      }
      await audit(q, user.id, 'complaint.comment', 'complaint_record', id, { comment_id: row.id });
      return { ...row, author: user.name || user.email };
    });
  }

  async function forConversation(convId) {
    return many(db, 'SELECT id, title, state, status FROM complaint_records r WHERE conversation_id = $1 ORDER BY id DESC', [convId]);
  }
  async function forContact(contactId) {
    return many(db, `SELECT r.id, r.title, r.state, r.status, r.original_service_date::text AS original_service_date, r.created_at FROM complaint_records r WHERE r.contact_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [contactId]);
  }

  // ---------- Input to UM Portal - Positive Feedback ----------
  async function positiveList() {
    return many(
      db,
      `SELECT f.conversation_id, f.flagged_at, COALESCE(fu.name, fu.email) AS flagged_by, c.subject, c.channel, c.last_preview, c.last_message_at, c.cleaner_name,
              c.contact_id, co.name AS contact_name, COALESCE(ow.name, ow.email) AS owner
         FROM um_portal_feedback f
         JOIN conversations c ON c.id = f.conversation_id
         LEFT JOIN contacts co ON co.id = c.contact_id
         LEFT JOIN users fu ON fu.id = f.flagged_by
         LEFT JOIN users ow ON ow.id = c.owner_id
        WHERE f.done_at IS NULL ORDER BY f.flagged_at DESC`,
    );
  }
  async function positiveFor(convId) {
    return one(db, 'SELECT conversation_id, flagged_at, done_at FROM um_portal_feedback WHERE conversation_id = $1', [convId]);
  }
  // action: flag (waiting to be entered) | done (entered in Launch27) | clear (flagged by mistake)
  async function positiveSet(user, convId, action) {
    if (!(await one(db, 'SELECT 1 FROM conversations WHERE id = $1', [convId]))) throw fail(404, 'Conversation not found');
    if (action === 'flag') await db.query('INSERT INTO um_portal_feedback (conversation_id, flagged_by) VALUES ($1, $2) ON CONFLICT (conversation_id) DO UPDATE SET flagged_by = EXCLUDED.flagged_by, flagged_at = now(), done_by = NULL, done_at = NULL', [convId, user.id]);
    else if (action === 'done') await db.query('UPDATE um_portal_feedback SET done_by = $2, done_at = now() WHERE conversation_id = $1', [convId, user.id]);
    else if (action === 'clear') await db.query('DELETE FROM um_portal_feedback WHERE conversation_id = $1', [convId]);
    else throw fail(400, 'Unknown action');
    await audit(db, user.id, `um_portal_feedback.${action}`, 'conversation', convId, {});
    return positiveFor(convId);
  }

  // ---------- what has worked before (the Complaint playbook) ----------
  // The playbook is built from history over the playbook's own window; it is heavy, so one
  // copy is kept for an hour.
  let pbCache = null;
  async function playbookNow() {
    if (pbCache && pbCache.at > now() - 3_600_000) return pbCache.value;
    const months = (await complaints.getSettings()).pilot_months || 6;
    const to = new Date(now() - 86_400_000).toISOString().slice(0, 10);
    const from = new Date(Date.parse(to) - months * 30.44 * 86_400_000).toISOString().slice(0, 10);
    const value = { from, to, book: await complaints.playbook({ from, to }) };
    pbCache = { at: now(), value };
    return value;
  }

  /** For one complaint: its playbook category, and what has kept clients for that kind before. */
  const CAUSE_MIN = 10;
  async function guidance(id) {
    if (!complaints) return { available: false, reason: 'The Complaint playbook is not running here.' };
    const r = await one(db, 'SELECT complaint_type, complaint_notes, frequency, title FROM complaint_records WHERE id = $1', [id]);
    if (!r) return null;
    let category = null;
    let basis = 'type';
    if (r.complaint_type && Object.hasOwn(TYPE_TO_PLAYBOOK, r.complaint_type)) category = TYPE_TO_PLAYBOOK[r.complaint_type];
    else if (!r.complaint_type) {
      // No Complaint Type yet: read the notes the way the playbook reads complaints.
      const text = [r.title, r.complaint_notes].filter(Boolean).join('. ');
      const guess = text.trim() ? classifyRules(text).category : 'other';
      category = guess !== 'other' ? guess : null;
      basis = 'notes';
    }
    if (!category) {
      return { available: true, category: null, basis, complaint_type: r.complaint_type, reason: r.complaint_type ? `"${r.complaint_type}" has no matching playbook category.` : 'Pick a Complaint Type (or add notes) to see what has worked before.' };
    }
    const { from, to, book } = await playbookNow();
    // Why it happened, read from the notes. When that cause has enough known outcomes
    // (CAUSE_MIN), its history is the better guide than the whole category's: a quality
    // complaint caused by a cleaner who left needs a different answer from one that wasn't.
    const notes = [r.title, r.complaint_notes].filter(Boolean).join('. ');
    const cause = notes.trim() ? causeRules(notes).cause : null;
    const byCause = cause ? (book.by_cause || []).find((x) => x.key === cause) : null;
    const useCause = !!byCause && byCause.decided >= CAUSE_MIN;
    const t = useCause ? byCause : (book.taxonomy || []).find((x) => x.key === category);
    const escalated = ['damage', 'missing_item', 'conduct_safety'].includes(category);
    const pick = (b) => b && { rung: b.rung, name: b.name, saved: b.saved, decided: b.decided, avg_cost: b.avg_cost, n: b.n };
    const oneTime = /one time/i.test(r.frequency || '');
    // Ranked responses from every past complaint like this one (what we offered, what the
    // client took, who stayed): the agent's options, best first.
    // Is the client threatening to leave or to post a review? Read from the notes' tone.
    const tone = notes.trim() ? classifyRules(notes).tone : null;
    const threat = tone === 'threat_review' ? 'review' : tone === 'threat_leave' ? 'leave' : 'none';
    const ranked = complaints.rankFor ? await complaints.rankFor({ category, cause, one_time: oneTime, threat }).catch(() => null) : null;
    return {
      ranked,
      threat,
      available: true,
      category,
      label: categoryLabel(category),
      basis,
      complaint_type: r.complaint_type,
      cause,
      cause_label: cause ? causeLabel(cause) : null,
      cause_cases: byCause?.n || 0,
      cause_decided: byCause?.decided || 0,
      based_on: useCause ? 'cause' : 'category',
      window: { from, to },
      escalation: escalated ? `${HARD_ROUTES.damage_over_100}, theft, safety or misconduct goes to the Office Manager, not the usual ladder.` : null,
      one_time: oneTime,
      cases: t?.n || 0,
      typical: t?.typical_name || null,
      saved: t?.saved ?? null,
      decided: t?.decided || 0,
      avg_cost: t?.avg_cost ?? null,
      cheapest: t?.cheapest_that_works || null,
      options: (t?.by_rung || []).filter((b) => b.n > 0).map(pick),
      one_time_stats: t?.one_time ? { n: t.one_time.n, decided_90: t.one_time.decided_90, rebooked_90: t.one_time.rebooked_90, decided: t.one_time.decided, rebooked_120: t.one_time.rebooked_120 } : null,
    };
  }

  // ---------- names -> records ----------
  // Links names that match exactly one record: staff names to logins, cleaner names to
  // Launch27 cleaners (when `teams` is given), and the cleaner set on the conversation.
  // Only fills ids that are empty; a name nobody matches stays as it was typed.
  async function linkNames(teams = null) {
    const out = { users: 0, cleaners: 0 };
    for (const l of USER_LINKS) {
      const match = `lower(btrim(u.name)) = lower(btrim(r.${l.key})) OR lower(u.email) = lower(btrim(r.${l.key}))`;
      const res = await db.query(
        `UPDATE complaint_records r SET ${l.id} = (SELECT u.id FROM users u WHERE ${match})
          WHERE r.${l.id} IS NULL AND r.${l.key} IS NOT NULL AND (SELECT count(*) FROM users u WHERE ${match}) = 1`,
      );
      out.users += res.rowCount || 0;
    }
    const conv = await db.query(
      `UPDATE complaint_records r SET cleaner_id = c.cleaner_id FROM conversations c
        WHERE c.id = r.conversation_id AND r.cleaner_id IS NULL AND c.cleaner_id IS NOT NULL AND lower(btrim(c.cleaner_name)) = lower(btrim(r.cleaner_name))`,
    );
    out.cleaners += conv.rowCount || 0;
    if (teams) {
      const index = cleanerIndex(teams);
      const open = await many(db, 'SELECT id, cleaner_name FROM complaint_records WHERE cleaner_id IS NULL AND cleaner_name IS NOT NULL');
      for (const r of open) {
        const hit = index.get(nameKey(r.cleaner_name));
        if (!hit) continue;
        await db.query('UPDATE complaint_records SET cleaner_id = $2, cleaner_name = $3 WHERE id = $1 AND cleaner_id IS NULL', [r.id, hit.id, hit.name]);
        out.cleaners++;
      }
    }
    return out;
  }

  // ---------- Kustomer load (read-only) ----------
  // Complaints created in the last `days` days, plus every complaint whose status isn't Closed
  // yet, so nothing still being worked is left behind. A complaint someone has since changed
  // here is never overwritten by a later load.
  async function runLoad({ days, teams = null }) {
    const client = createKustomerClient({ apiKey: config.kustomerApiKey, fetchImpl });
    const found = await discover(client, { klass: config.kustomerComplaintKlass });
    if (!found.complaint_klass || !found.listing) throw new Error(`Kustomer: couldn't list the complaint records. ${(found.attempts || []).map((a) => `${a.label}: ${a.error || 'ok'}`).join(' | ')}`);
    const since = new Date(now() - days * 86_400_000).toISOString();
    const stats = { seen: 0, loaded: 0, kept_as_edited: 0, comments: 0, linked_conversation: 0, linked_contact: 0 };
    for await (const { data } of client.pages(found.listing.path, { ...found.listing.query, pageSize: 100 }, 300)) {
      for (const ko of data) {
        stats.seen++;
        const a = ko.attributes || {};
        // Older than the window: only what is still being worked (a status, and not Closed).
        const status = String(a.custom?.statusStr || '').toLowerCase();
        if ((!status || status === 'closed') && !(a.createdAt && a.createdAt >= since)) continue;
        const rec = fromKustomer(ko);
        const conv = rec.source_meta.conversation ? await one(db, "SELECT id, contact_id FROM conversations WHERE source = 'kustomer' AND source_id = $1", [rec.source_meta.conversation]) : null;
        const mapped = rec.source_meta.customer ? await one(db, 'SELECT contact_id FROM kustomer_contacts WHERE kustomer_customer_id = $1 ORDER BY contact_id LIMIT 1', [rec.source_meta.customer]) : null;
        const contactId = mapped?.contact_id || conv?.contact_id || null;
        const contact = contactId ? await one(db, 'SELECT name, l27_customer_id FROM contacts WHERE id = $1', [contactId]) : null;
        if (!rec.fields.customer_name && contact?.name) rec.fields.customer_name = contact.name;
        const cols = { title: rec.title, state: rec.state, snooze_until: rec.snooze_until, conversation_id: conv?.id || null, contact_id: contactId, l27_customer_id: contact?.l27_customer_id || null, ...rec.fields };
        const keys = Object.keys(cols);
        const row = await one(
          db,
          `INSERT INTO complaint_records (source, source_id, source_meta, created_at, ${keys.join(', ')})
           VALUES ('kustomer', $1, $2::jsonb, COALESCE($3::timestamptz, now()), ${keys.map((_, i) => `$${i + 4}`).join(', ')})
           ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL DO UPDATE SET source_meta = EXCLUDED.source_meta, updated_at = now(), ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}
             WHERE complaint_records.edited_at IS NULL
           RETURNING id`,
          [rec.source_id, JSON.stringify(rec.source_meta), rec.created_at, ...keys.map((k) => cols[k])],
        );
        if (!row) {
          stats.kept_as_edited++;
          continue;
        }
        stats.loaded++;
        if (conv) stats.linked_conversation++;
        if (contactId) stats.linked_contact++;
        if (rec.source_meta.comment_count > 0) {
          const body = await client.get(`/v1/kobjects/${encodeURIComponent(rec.source_id)}/comments`, { pageSize: 100 }).catch((err) => {
            log.warn('complaint tracker: comments not read', { error: err.message });
            return null;
          });
          for (const c of body?.data || []) {
            const text = unescapeComment(c.attributes?.body).trim();
            if (!text) continue;
            const added = await one(db, "INSERT INTO complaint_record_comments (record_id, author_name, body, source_id, created_at) VALUES ($1, 'Kustomer comment', $2, $3, COALESCE($4::timestamptz, now())) ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING RETURNING id", [row.id, text, `kustomer:${c.id}`, c.attributes?.createdAt || null]);
            if (added) stats.comments++;
          }
        }
      }
    }
    const cleanerList = teams ? await teams().catch((err) => {
      log.warn('complaint tracker: Launch27 cleaners not read, cleaner names left unlinked', { error: err.message });
      return null;
    }) : null;
    stats.linked = await linkNames(cleanerList);
    return stats;
  }

  function startLoad(user, { days = 30, teams = null } = {}) {
    if (!config.kustomerApiKey) throw fail(409, 'Kustomer is only connected in production (KUSTOMER_API_KEY)');
    if (load.running) throw fail(409, 'A load from Kustomer is already running');
    const d = Math.min(365, Math.max(1, Number(days) || 30));
    load = { running: true, started_at: new Date(now()).toISOString(), finished_at: null, result: null, error: null, days: d };
    load.promise = runLoad({ days: d, teams })
      .then(async (result) => {
        load = { ...load, running: false, finished_at: new Date(now()).toISOString(), result };
        log.info('complaint tracker: loaded from Kustomer', result);
        await audit(db, user?.id || null, 'complaint.kustomer_load', 'complaint_record', 'kustomer', { days: d, ...result }).catch(() => {});
      })
      .catch((err) => {
        load = { ...load, running: false, finished_at: new Date(now()).toISOString(), error: err.message };
        log.error('complaint tracker: Kustomer load failed', { error: err.message });
      });
    return loadStatus();
  }
  function loadStatus() {
    const { promise: _p, ...rest } = load;
    return { ...rest, connected: !!config.kustomerApiKey };
  }
  const loadDone = () => load.promise || Promise.resolve();

  // Dev and QA have no Kustomer: a few invented complaints so the screens can be tried.
  async function ensureSample() {
    if (config.l27Mode !== 'mock') return 0;
    if (await one(db, 'SELECT 1 FROM complaint_records LIMIT 1')) return 0;
    const convs = await many(db, 'SELECT c.id, c.contact_id, co.name FROM conversations c LEFT JOIN contacts co ON co.id = c.contact_id WHERE c.contact_id IS NOT NULL ORDER BY c.id LIMIT 3');
    const t = today();
    const day = (offset) => new Date(Date.parse(`${t}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const samples = [
      { title: 'Missed Areas : Sample Cleaner One', status: 'For Review', original_service_date: day(-2), cleaner_name: 'Sample Cleaner One', complaint_type: 'Quality of Cleaning', tier_level: 'Tier 1', complaint_notes: 'Stove hood and bathroom counter were missed.', received_photos: 'Yes', due_date: day(1), type_of_service: 'Regular Cleaning', frequency: 'Bi-weekly', ltv_of_client: 1840 },
      { title: 'Broken lamp : Sample Cleaner Two', status: 'Damaged item for repair/reimbursement in process', original_service_date: day(-9), cleaner_name: 'Sample Cleaner Two', complaint_type: 'Damage/Broken Item', tier_level: 'Tier 2', complaint_notes: 'Client reports a lamp was knocked over.', received_photos: 'Yes', proposed_solution: 'Reimburse the lamp on receipt.', input_into_um_portal: 'Yes', ltv_of_client: 5120 },
      { title: 'Complaint for a sample client', status: 'Awaiting client response', original_service_date: day(-4), cleaner_name: 'Sample Cleaner One', complaint_type: 'Quality of Cleaning', tier_level: 'Tier 1', complaint_notes: 'Floors still dusty in the hallway.', proposed_solution: 'Offered a reclean on Thursday.', received_photos: 'No', input_into_um_portal: 'No', ltv_of_client: 261 },
      { title: 'Late arrival : Sample Cleaner Three', status: 'Reclean scheduled', original_service_date: day(-6), cleaner_name: 'Sample Cleaner Three', complaint_type: 'Punctuality', tier_level: 'Tier 1', complaint_notes: 'Cleaner arrived 50 minutes late and left early.', proposed_solution: 'Reclean booked.', reclean_scheduling_required: 'Done', input_into_um_portal: 'Yes', ltv_of_client: 940 },
      { title: 'Refund request : sample client', status: 'For refund', original_service_date: day(-12), cleaner_name: 'Sample Cleaner Two', complaint_type: 'Quality of Cleaning', tier_level: 'Tier 2', complaint_notes: 'Client asks for money back.', proposed_solution: 'Partial refund of $60.', final_resolution_category: 'Partial Refund', input_into_um_portal: 'Yes', ltv_of_client: 148 },
      { title: 'Closed sample, waiting on the impact assessment', status: 'Closed', state: 'done', original_service_date: day(-15), cleaner_name: 'Sample Cleaner Three', complaint_type: 'Quality of Cleaning', tier_level: 'Tier 1', final_resolution_category: 'Reclean', final_resolution_details: 'Reclean done, client happy.', input_into_um_portal: 'Yes', closed_date: day(-11), ltv_of_client: 2300 },
      { title: 'Closed sample, fully assessed', status: 'Closed', state: 'done', original_service_date: day(-20), cleaner_name: 'Sample Cleaner One', complaint_type: 'Quality of Cleaning', complaint_category: 'Cleaner', complaint_sub_category: 'Quality', tier_level: 'Tier 1', final_resolution_category: 'Reclean', manager_approval: 'Sample Manager', manager_impact_assessment: '44', mia_categories: 'Expenses related to recleans or poor-quality cleanings', input_into_um_portal: 'Yes', closed_date: day(-17), ltv_of_client: 584 },
      { title: 'Resolved, checking what went wrong', status: 'Complaint Resolved | For Internal Investigation', original_service_date: day(-5), cleaner_name: 'Sample Cleaner Two', complaint_type: "Not following Client's Instruction", tier_level: 'Tier 3', complaint_notes: 'Client asked for no bleach; bleach was used.', final_resolution_category: 'Complimentary Clean', input_into_um_portal: 'Yes', ltv_of_client: 3310 },
    ];
    let i = 0;
    for (const s of samples) {
      const link = convs[i] || null;
      const cols = { ...s, complaint_created_on: s.original_service_date ? day(0) : null, case_opened_by: 'Sample Agent', customer_name: link?.name || `Sample Client ${i + 1}`, conversation_id: link?.id || null, contact_id: link?.contact_id || null };
      const keys = Object.keys(cols);
      await db.query(`INSERT INTO complaint_records (source, source_id, ${keys.join(', ')}) VALUES ('sample', $1, ${keys.map((_, k) => `$${k + 2}`).join(', ')}) ON CONFLICT DO NOTHING`, [`sample-${i + 1}`, ...keys.map((k) => cols[k])]);
      i++;
    }
    return samples.length;
  }

  return { meta, counts, list, get, create, patch, bulk, comment, forConversation, forContact, positiveList, positiveFor, positiveSet, linkNames, guidance, startLoad, loadStatus, loadDone, ensureSample, FIELD_KEYS };
}
