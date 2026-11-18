// Dry run: match every exported Kustomer customer to a Launch27 customer and decide what an
// import would do with each conversation, without changing anything. Live data (contacts,
// conversations, messages) is read through a SELECT-only handle; results go to the
// kustomer_dry_runs / kustomer_plan_* tables only.
//
// Matching (Launch27 is the authority; identities agents already linked count as established):
//   1. the customer's emails, primary first: Launch27 customer emails + support-contact emails
//   2. then phone numbers that agents already linked to a contact (established relationship)
//   3. a Launch27 customer's own phone number alone is only a "review" match (phones are shared)
// One customer → confident. Several from one address → ambiguous. Different addresses of the
// same Kustomer profile pointing at different customers → conflict. Cleaners and our own
// addresses are classified separately. Nothing is guessed from names or message text.
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
  const slot = (map, key) => {
    if (!map.has(key)) map.set(key, { customers: new Set(), teams: new Set(), contacts: new Set(), established: new Set() });
    return map.get(key);
  };
  for (const c of customers) {
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
  // Identities on support contacts: confirmed by agents (or by Launch27 when the contact was made).
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
  }
  const domains = new Set(ourDomains.map((d) => d.toLowerCase()));
  return { email: (e) => byEmail.get(e), phone: (p) => byPhone.get(p), internal: (e) => domains.has(domainOf(e)) };
}

/** Which Launch27 customer a Kustomer customer is, and how sure we are. */
export function matchCustomer(kc, dir) {
  const emails = kc.emails.map((e) => e.email).filter((e) => !dir.internal(e));
  if (!emails.length && !kc.phones.length) return kc.emails.length ? { match: 'internal', reason: 'only our own addresses' } : { match: 'unmatched', reason: 'no email or phone in Kustomer' };
  const perEmail = emails.map((e) => ({ e, s: dir.email(e) }));
  const fromEmails = new Set();
  const teams = new Set();
  let ambiguousAddress = null;
  for (const { e, s } of perEmail) {
    if (!s) continue;
    for (const t of s.teams) teams.add(t);
    if (s.customers.size > 1) ambiguousAddress = e;
    for (const c of s.customers) fromEmails.add(c);
  }
  if (ambiguousAddress) return { match: 'ambiguous', candidates: [...fromEmails], reason: 'an address is on several Launch27 customers' };
  if (fromEmails.size > 1) return { match: 'conflict', candidates: [...fromEmails], reason: 'its addresses belong to different Launch27 customers' };
  if (fromEmails.size === 1) {
    const id = [...fromEmails][0];
    const firstHit = perEmail.find(({ s }) => s?.customers.has(id));
    return { match: 'confident', l27_customer_id: id, method: firstHit.e === emails[0] ? 'email' : 'secondary_email', candidates: [id] };
  }
  if (teams.size) return { match: 'cleaner', reason: 'a Launch27 cleaner' };
  // No email match: phones agents already linked, then Launch27's own phone field (review only).
  const established = new Set();
  const byField = new Set();
  for (const p of kc.phones) {
    const s = dir.phone(p);
    if (!s) continue;
    if (s.teams.size && !s.customers.size) teams.add([...s.teams][0]);
    for (const c of s.established) established.add(c);
    for (const c of s.customers) byField.add(c);
  }
  if (established.size === 1) return { match: 'confident', l27_customer_id: [...established][0], method: 'contact', candidates: [...established] };
  if (established.size > 1 || byField.size > 1) return { match: 'ambiguous', candidates: [...new Set([...established, ...byField])], reason: 'the phone number is on several Launch27 customers' };
  if (byField.size === 1) return { match: 'review', l27_customer_id: [...byField][0], method: 'phone', candidates: [...byField], reason: 'matched by phone number only: confirm before importing' };
  if (teams.size) return { match: 'cleaner', reason: 'a Launch27 cleaner' };
  return { match: 'unmatched', reason: 'no Launch27 customer with these addresses or numbers' };
}

const MATCHES = ['confident', 'review', 'ambiguous', 'conflict', 'unmatched', 'cleaner', 'internal'];

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
    const imported = new Set((await ro.query("SELECT source_id FROM conversations WHERE source = 'kustomer'")).rows.map((r) => r.source_id));
    const totals = { customers: 0, conversations: 0, messages: 0, notes: 0, attachments: 0, duplicate_messages: 0, preview_only_messages: 0, new_conversations: 0, already_imported: 0, match: Object.fromEntries(MATCHES.map((m) => [m, 0])), conversations_by_match: Object.fromEntries(MATCHES.map((m) => [m, 0])), by_channel: {}, by_direction: { in: 0, out: 0, unknown: 0 }, oldest: null, newest: null, duplicate_identities: 0, l27_customers: 0, errors: [] };
    const l27Seen = new Map(); // l27 id -> kustomer customers mapped to it
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
        totals.customers++;
        totals.match[m.match]++;
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
          if (action === 'new') totals.new_conversations++;
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
        custRows.push({ id: kid, ...m, contact_id: m.l27_customer_id ? contactFor.get(m.l27_customer_id) ?? null : null, conversations: [...g.convs.values()].filter((c) => c.conv).length, messages: nMsg, notes: nNote });
      }
      await store.tx(async (q) => {
        for (const c of custRows) {
          await q.query(
            `INSERT INTO kustomer_plan_customers (run_id, kustomer_customer_id, match, method, l27_customer_id, contact_id, candidates, reason, conversations, messages, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7::bigint[],$8,$9,$10,$11)`,
            [runId, c.id, c.match, c.method || null, c.l27_customer_id ?? null, c.contact_id, c.candidates || [], c.reason || null, c.conversations, c.messages, c.notes],
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
    latest: async () => (await store.query('SELECT * FROM kustomer_dry_runs ORDER BY id DESC LIMIT 1')).rows[0] || null,
    async recover() {
      await store.query("UPDATE kustomer_dry_runs SET status = 'failed', last_error = 'Interrupted by a server restart. Run it again.', finished_at = now() WHERE status = 'running'");
    },
  };
}
