// Dry run: decide where every exported Kustomer customer's history goes, without changing
// anything. Live data (contacts, conversations, messages) is read through a SELECT-only
// handle; results go to the kustomer_dry_runs / kustomer_plan_* tables only.
//
// Every profile gets a target (Launch27 is the authority; identities agents already linked
// count as established):
//   1. its emails, primary first: Launch27 customer emails + support-contact emails
//   2. a Launch27 cleaner with one of those emails → the cleaner's profile
//   3. phone numbers agents already linked to a customer, then Launch27's own phone field
//   4. a contact already in the inbox (not in Launch27) with the same email, or the same phone
//      when Kustomer has no email for them
//   5. nobody: a new customer profile from the Kustomer details (internal accounts too)
// When an address or number is on several Launch27 customers, one is picked by rule: the
// primary address first; on a tie the customer agents already linked, else the most recently
// created. Nothing is decided from names or message text.
import { normalizeEmail, normalizePhone } from '../inbox/normalize.js';
import * as K from './normalize.js';
import { migrationDb, sanitize } from './export.js';

/** A database handle that only runs SELECT / WITH … SELECT. */
export function readOnlyDb(db) {
  return {
    query(sql, params) {
      const s = String(sql).replace(/--.*$/gm, '').trim();
      if (!/^(select|with)\b/i.test(s) || /\b(insert|update|delete|truncate|alter|drop|create)\b\s/i.test(s.replace(/'[^']*'/g, ''))) throw new Error('The dry run attempted a write');
      return db.query(sql, params);
    },
  };
}

const domainOf = (e) => String(e).split('@')[1] || '';

export function buildDirectory({ customers = [], teams = [], contacts = [], ourDomains = [] }) {
  const byEmail = new Map();
  const byPhone = new Map();
  const created = new Map(); // Launch27 customer id -> when it was created (ms), for ties
  const slot = (map, key) => {
    if (!map.has(key)) map.set(key, { customers: new Set(), teams: new Set(), contacts: new Set(), established: new Set(), unlinked: new Set() });
    return map.get(key);
  };
  for (const c of customers) {
    const at = Date.parse(c.created_at || '');
    created.set(Number(c.id), Number.isNaN(at) ? null : at);
    const e = !c.has_generated_email && normalizeEmail(c.email);
    if (e) slot(byEmail, e).customers.add(Number(c.id));
    const p = normalizePhone(c.phone);
    if (p) slot(byPhone, p).customers.add(Number(c.id));
  }
  for (const t of teams) {
    const e = normalizeEmail(t.email);
    if (e) slot(byEmail, e).teams.add(Number(t.id));
    const p = normalizePhone(t.phone);
    if (p) slot(byPhone, p).teams.add(Number(t.id));
  }
  // Identities on support contacts: confirmed by agents (or by Launch27 when the contact was
  // made). Contacts linked to neither a customer nor a cleaner are "unlinked": people the inbox
  // already knows who aren't in Launch27.
  for (const row of contacts) {
    const key = row.kind === 'email' ? normalizeEmail(row.value) : normalizePhone(row.value);
    if (!key) continue;
    const s = slot(row.kind === 'email' ? byEmail : byPhone, key);
    s.contacts.add(Number(row.contact_id));
    if (row.l27_customer_id) {
      s.customers.add(Number(row.l27_customer_id));
      s.established.add(Number(row.l27_customer_id));
    }
    if (row.l27_team_id) s.teams.add(Number(row.l27_team_id));
    if (!row.l27_customer_id && !row.l27_team_id) s.unlinked.add(Number(row.contact_id));
  }
  const domains = new Set(ourDomains.map((d) => d.toLowerCase()));
  // The most recently created of several Launch27 customers (unknown dates last), then the highest id.
  const newest = (ids) => [...ids].sort((a, b) => (created.get(b) ?? -Infinity) - (created.get(a) ?? -Infinity) || b - a)[0];
  return { email: (e) => byEmail.get(e), phone: (p) => byPhone.get(p), internal: (e) => domains.has(domainOf(e)), newest };
}

/**
 * Where a Kustomer customer's history goes, and why. Every profile gets a target:
 *   customer (l27_customer_id) · cleaner (l27_team_id) · contact (contact_id) · new (a new profile)
 * The match says how: confident | phone | picked | cleaner | existing | internal | new_profile.
 */
export function matchCustomer(kc, dir) {
  const emails = kc.emails.map((e) => e.email);
  const external = emails.filter((e) => !dir.internal(e));
  // On a tie: the customer agents already linked, else the most recently created.
  const pick = (ids, established) => {
    const linked = [...ids].filter((id) => established.has(id));
    if (linked.length === 1) return { id: linked[0], why: 'the one agents already linked' };
    return { id: dir.newest(linked.length ? linked : ids), why: 'the most recently created' };
  };
  const customer = (match, id, method, candidates, reason) => ({ match, target: 'customer', l27_customer_id: id, method, candidates, ...(reason ? { reason } : {}) });

  // 1. Launch27 customers by email, primary first. (Never addresses in a reason: the report is sanitized.)
  const hits = external.map((e, i) => ({ i, s: dir.email(e) })).filter((h) => h.s?.customers.size);
  if (hits.length) {
    const all = [...new Set(hits.flatMap((h) => [...h.s.customers]))];
    const { i, s } = hits[0];
    const method = i === 0 ? 'email' : 'secondary_email';
    if (all.length === 1) return customer('confident', all[0], method, all);
    const where = i === 0 ? 'the primary address' : 'the first address that matches';
    if (s.customers.size > 1) {
      const p = pick(s.customers, s.established);
      return customer('picked', p.id, method, all, `${where} is on ${s.customers.size} Launch27 customers: picked ${p.why}`);
    }
    return customer('picked', [...s.customers][0], method, all, `its addresses belong to ${all.length} Launch27 customers: picked the one with ${where}`);
  }
  // 2. A Launch27 cleaner by email.
  for (const e of external) {
    const s = dir.email(e);
    if (s?.teams.size) return { match: 'cleaner', target: 'cleaner', l27_team_id: Math.min(...s.teams), method: 'email', candidates: [], reason: 'a Launch27 cleaner' };
  }
  // 3. Phones: numbers agents already linked to a customer, then Launch27's own phone field.
  const established = new Set();
  const byField = new Set();
  let team = null;
  for (const p of kc.phones) {
    const s = dir.phone(p);
    if (!s) continue;
    for (const c of s.established) established.add(c);
    for (const c of s.customers) byField.add(c);
    if (team == null && s.teams.size && !s.customers.size) team = Math.min(...s.teams);
  }
  if (established.size === 1) return customer('confident', [...established][0], 'contact', [...established]);
  if (established.size > 1) return customer('picked', dir.newest(established), 'contact', [...established], `the phone number is linked to ${established.size} Launch27 customers: picked the most recently created`);
  if (byField.size === 1) return customer('phone', [...byField][0], 'phone', [...byField], 'matched by phone number only');
  if (byField.size > 1) return customer('picked', dir.newest(byField), 'phone', [...byField], `the phone number is on ${byField.size} Launch27 customers: picked the most recently created`);
  if (team != null) return { match: 'cleaner', target: 'cleaner', l27_team_id: team, method: 'phone', candidates: [], reason: 'a Launch27 cleaner' };

  // 4. A contact already in the inbox, not in Launch27: by email, or by phone when Kustomer has no
  // email for them (a phone alone is often shared by a family).
  const internal = !external.length && emails.length > 0;
  const existing = (contactId, method) => ({ match: internal ? 'internal' : 'existing', target: 'contact', contact_id: contactId, method, candidates: [], reason: internal ? 'only our own addresses: an existing contact' : 'a contact already in the inbox, not in Launch27' });
  for (const e of emails) {
    const s = dir.email(e);
    if (s?.unlinked.size) return existing(Math.min(...s.unlinked), 'email');
  }
  if (!emails.length) {
    for (const p of kc.phones) {
      const s = dir.phone(p);
      if (s?.unlinked.size) return existing(Math.min(...s.unlinked), 'phone');
    }
  }
  // 5. Nobody known: a new customer profile from the Kustomer details.
  if (internal) return { match: 'internal', target: 'new', candidates: [], reason: 'only our own addresses: a new internal profile' };
  return { match: 'new_profile', target: 'new', candidates: [], reason: emails.length || kc.phones.length ? 'no Launch27 customer, cleaner or contact with these addresses or numbers' : 'no email or phone in Kustomer' };
}

export const MATCHES = ['confident', 'phone', 'picked', 'cleaner', 'existing', 'internal', 'new_profile'];
export const TARGETS = ['customer', 'cleaner', 'contact', 'new'];
// Plans made before every conversation got a target can't be imported (run the dry run again).
export const PLAN_VERSION = 2;

export function createKustomerDryRun({ db, vault, l27Directory, ourDomains = [], log = () => {}, chunk = 200 }) {
  const store = migrationDb(db);
  const ro = readOnlyDb(db);
  let running = null;

  async function liveIndex(messages) {
    // Email: the Message-ID the live Gmail channel stores. SMS: same number, text and minute.
    const ids = [...new Set(messages.map((m) => m.email_message_id).filter(Boolean))];
    const emailHits = new Set();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const rows = (await ro.query("SELECT meta->>'message_id' AS mid, external_id FROM messages WHERE channel = 'email' AND (meta->>'message_id' = ANY($1::text[]) OR external_id = ANY($2::text[]))", [part, part.map((x) => `email:${x.toLowerCase()}`)])).rows;
      for (const r of rows) {
        if (r.mid) emailHits.add(r.mid.toLowerCase());
        if (r.external_id?.startsWith('email:')) emailHits.add(r.external_id.slice(6));
      }
    }
    const phones = [...new Set(messages.filter((m) => m.channel === 'sms').flatMap((m) => [normalizePhone(m.from), ...m.to.map(normalizePhone)]).filter(Boolean))];
    const smsKeys = new Set();
    for (let i = 0; i < phones.length; i += 500) {
      const part = phones.slice(i, i + 500);
      const rows = (await ro.query("SELECT from_addr, to_addr, body, created_at FROM messages WHERE channel = 'sms' AND kind = 'message' AND (from_addr = ANY($1::text[]) OR to_addr = ANY($1::text[]))", [part])).rows;
      for (const r of rows) smsKeys.add(`${(r.body || '').trim()}|${Math.floor(new Date(r.created_at).getTime() / 60_000)}`);
    }
    return {
      duplicate(m) {
        if (m.email_message_id && emailHits.has(m.email_message_id.toLowerCase())) return true;
        if (m.channel === 'sms' && m.sent_at) {
          const t = Math.floor(new Date(m.sent_at).getTime() / 60_000);
          return [t - 1, t, t + 1].some((x) => smsKeys.has(`${(m.body || '').trim()}|${x}`));
        }
        return false;
      },
    };
  }

  async function execute(runId) {
    const { customers, teams } = await l27Directory();
    const contacts = (await ro.query('SELECT i.kind, i.value, c.id AS contact_id, c.l27_customer_id, c.l27_team_id FROM contact_identities i JOIN contacts c ON c.id = i.contact_id')).rows;
    const dir = buildDirectory({ customers, teams, contacts, ourDomains });
    const contactFor = new Map((await ro.query('SELECT DISTINCT ON (l27_customer_id) l27_customer_id, id FROM contacts WHERE l27_customer_id IS NOT NULL ORDER BY l27_customer_id, id')).rows.map((r) => [Number(r.l27_customer_id), Number(r.id)]));
    const contactForTeam = new Map((await ro.query('SELECT DISTINCT ON (l27_team_id) l27_team_id, id FROM contacts WHERE l27_team_id IS NOT NULL ORDER BY l27_team_id, id')).rows.map((r) => [Number(r.l27_team_id), Number(r.id)]));
    // Profiles an earlier import already made for a Kustomer customer: the import adds to them.
    const madeBefore = new Map((await ro.query("SELECT kustomer_customer_id, min(contact_id) AS contact_id FROM kustomer_contacts WHERE kind IN ('profile', 'internal') GROUP BY kustomer_customer_id")).rows.map((r) => [r.kustomer_customer_id, Number(r.contact_id)]));
    const imported = new Set((await ro.query("SELECT source_id FROM conversations WHERE source = 'kustomer'")).rows.map((r) => r.source_id));
    const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
    const totals = { plan_version: PLAN_VERSION, customers: 0, conversations: 0, messages: 0, notes: 0, attachments: 0, duplicate_messages: 0, preview_only_messages: 0, new_conversations: 0, already_imported: 0, match: zero(MATCHES), conversations_by_match: zero(MATCHES), by_target: zero(TARGETS), new_profiles: 0, by_channel: {}, by_direction: { in: 0, out: 0, unknown: 0 }, oldest: null, newest: null, duplicate_identities: 0, l27_customers: 0, errors: [] };
    const l27Seen = new Map(); // l27 id -> kustomer customers mapped to it
    const profileKeys = new Set(); // emails/phones of the new profiles counted so far (several Kustomer profiles may share one)
    const ids = (await ro.query("SELECT kustomer_id FROM kustomer_records WHERE kind = 'customer' ORDER BY kustomer_id")).rows.map((r) => r.kustomer_id);
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const recs = (await ro.query('SELECT kind, kustomer_id, customer_id, conversation_id, data FROM kustomer_records WHERE customer_id = ANY($1::text[])', [part])).rows;
      const open = (r) => {
        try {
          return vault.open(r.data);
        } catch (err) {
          totals.errors.push({ kind: r.kind, kustomer_id: r.kustomer_id, error: sanitize(err) });
          return null;
        }
      };
      const byCustomer = new Map(part.map((id) => [id, { customer: null, convs: new Map() }]));
      const msgs = [];
      for (const r of recs) {
        const raw = open(r);
        if (!raw) continue;
        const g = byCustomer.get(r.customer_id);
        if (!g) continue;
        if (r.kind === 'customer') g.customer = K.customer(raw);
        else if (r.kind === 'conversation') {
          const c = g.convs.get(r.kustomer_id) || { messages: [], notes: [], attachments: 0 };
          g.convs.set(r.kustomer_id, Object.assign(c, { conv: K.conversation(raw) }));
        } else {
          const c = g.convs.get(r.conversation_id) || { messages: [], notes: [], attachments: 0 };
          g.convs.set(r.conversation_id, c);
          if (r.kind === 'message') {
            const m = K.message(raw);
            c.messages.push(m);
            msgs.push(m);
          } else if (r.kind === 'note') c.notes.push(K.note(raw));
          else if (r.kind === 'attachment') c.attachments++;
        }
      }
      const live = await liveIndex(msgs);
      const custRows = [];
      const convRows = [];
      for (const [kid, g] of byCustomer) {
        if (!g.customer) continue;
        const m = matchCustomer(g.customer, dir);
        // The support contact the import would use (null: made by the import).
        const contactId = m.target === 'customer' ? contactFor.get(m.l27_customer_id) ?? null : m.target === 'cleaner' ? contactForTeam.get(m.l27_team_id) ?? null : m.target === 'contact' ? m.contact_id : madeBefore.get(kid) ?? null;
        totals.customers++;
        totals.match[m.match]++;
        totals.by_target[m.target]++;
        let toImport = 0;
        if (m.l27_customer_id) {
          if (l27Seen.has(m.l27_customer_id)) totals.duplicate_identities++;
          l27Seen.set(m.l27_customer_id, (l27Seen.get(m.l27_customer_id) || 0) + 1);
        }
        let nMsg = 0;
        let nNote = 0;
        for (const [cid, c] of g.convs) {
          if (!c.conv) continue; // messages whose conversation record is missing are counted in errors below
          const sorted = c.messages.sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
          const dup = sorted.filter((x) => live.duplicate(x)).length;
          const preview = sorted.filter((x) => x.preview_only).length;
          const action = imported.has(cid) ? 'already_imported' : sorted.length - dup + c.notes.length === 0 ? 'skip' : 'new';
          const first = sorted[0]?.sent_at || c.conv.created_at;
          const last = sorted.at(-1)?.sent_at || c.conv.updated_at;
          convRows.push({ id: cid, customer: kid, l27: m.l27_customer_id ?? null, action, match: m.match, channels: [...new Set([...c.conv.channels, ...sorted.map((x) => x.channel)])].filter(Boolean), messages: sorted.length, notes: c.notes.length, dup, preview, first, last, reason: action === 'skip' ? 'nothing new: every message is already in the inbox' : null });
          totals.conversations++;
          totals.conversations_by_match[m.match]++;
          totals.messages += sorted.length;
          totals.notes += c.notes.length;
          totals.attachments += c.attachments;
          totals.duplicate_messages += dup;
          totals.preview_only_messages += preview;
          if (action === 'new') {
            totals.new_conversations++;
            toImport++;
          }
          if (action === 'already_imported') totals.already_imported++;
          for (const x of sorted) {
            totals.by_channel[x.channel] = (totals.by_channel[x.channel] || 0) + 1;
            totals.by_direction[x.direction || 'unknown']++;
          }
          if (first && (!totals.oldest || first < totals.oldest)) totals.oldest = first;
          if (last && (!totals.newest || last > totals.newest)) totals.newest = last;
          nMsg += sorted.length;
          nNote += c.notes.length;
        }
        if (m.target === 'new' && contactId == null && toImport) {
          // About how many profiles the import will make. Like the import: a profile with an email
          // joins one that already has it (without emails, by phone), and takes its phones too.
          const emailKeys = g.customer.emails.map((e) => `e:${e.email}`);
          const phoneKeys = g.customer.phones.map((p) => `p:${p}`);
          if (!(emailKeys.length ? emailKeys : phoneKeys).some((k) => profileKeys.has(k))) totals.new_profiles++;
          for (const k of [...emailKeys, ...phoneKeys]) profileKeys.add(k);
        }
        custRows.push({ id: kid, ...m, contact_id: contactId, conversations: [...g.convs.values()].filter((c) => c.conv).length, messages: nMsg, notes: nNote });
      }
      await store.tx(async (q) => {
        for (const c of custRows) {
          await q.query(
            `INSERT INTO kustomer_plan_customers (run_id, kustomer_customer_id, match, target, method, l27_customer_id, l27_team_id, contact_id, candidates, reason, conversations, messages, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint[],$10,$11,$12,$13)`,
            [runId, c.id, c.match, c.target, c.method || null, c.l27_customer_id ?? null, c.l27_team_id ?? null, c.contact_id, c.candidates || [], c.reason || null, c.conversations, c.messages, c.notes],
          );
        }
        for (const c of convRows) {
          await q.query(
            `INSERT INTO kustomer_plan_conversations (run_id, kustomer_conversation_id, kustomer_customer_id, l27_customer_id, action, match, channels, messages, notes, duplicate_messages, preview_only_messages, first_at, last_at, reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13,$14)`,
            [runId, c.id, c.customer, c.l27, c.action, c.match, c.channels, c.messages, c.notes, c.dup, c.preview, c.first, c.last, c.reason],
          );
        }
      });
    }
    totals.l27_customers = l27Seen.size;
    totals.errors = totals.errors.slice(0, 200);
    await store.query("UPDATE kustomer_dry_runs SET status = 'completed', results = $2::jsonb, finished_at = now() WHERE id = $1", [runId, JSON.stringify(totals)]);
    log('info', 'kustomer dry run completed', { run: runId, customers: totals.customers, conversations: totals.conversations });
    return totals;
  }

  return {
    async start(user) {
      if (running) throw Object.assign(new Error('A dry run is already running'), { status: 409 });
      const run = (await store.query('INSERT INTO kustomer_dry_runs (created_by) VALUES ($1) RETURNING *', [user?.id ?? null])).rows[0];
      running = execute(run.id)
        .catch(async (err) => {
          log('error', 'kustomer dry run failed', { run: run.id, error: sanitize(err) });
          await store.query("UPDATE kustomer_dry_runs SET status = 'failed', last_error = $2, finished_at = now() WHERE id = $1", [run.id, sanitize(err)]).catch(() => {});
        })
        .finally(() => {
          running = null;
        });
      return run;
    },
    wait: () => running || Promise.resolve(),
    isActive: () => !!running,
    /** For the import: which of these messages the live inbox already has. */
    duplicates: async (messages) => (await liveIndex(messages)).duplicate,
    latest: async () => (await store.query('SELECT * FROM kustomer_dry_runs ORDER BY id DESC LIMIT 1')).rows[0] || null,
    async recover() {
      await store.query("UPDATE kustomer_dry_runs SET status = 'failed', last_error = 'Interrupted by a server restart. Run it again.', finished_at = now() WHERE status = 'running'");
    },
  };
}
