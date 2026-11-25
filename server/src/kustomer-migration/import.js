// The live import of Kustomer history (approved). Anyone signed in can start it from the
// Kustomer migration page; it imports the latest completed dry run's plan in batches, can be
// stopped and resumed, and a run can be rolled back. KUSTOMER_IMPORT_ENABLED switches it off.
//
// What it does, per planned conversation (from a dry run), in one transaction per batch:
//   - one historical conversation: status done, original dates, no queue, owner, reply target
//     or SLA clock, always on someone's support contact (the dry run's target):
//       customer  the Launch27 customer's contact (created once if they have none)
//       cleaner   the Launch27 cleaner's contact (created once if they have none)
//       contact   a contact already in the inbox, not in Launch27
//       new       a new customer profile made from the Kustomer name, emails and phones (internal
//                 accounts too). Kustomer profiles that share an email end up on one profile; an
//                 email or phone another contact already has isn't added, so live messages from
//                 it keep going where they went before;
//   - its messages with original timestamps and direction, delivery_state 'historical';
//   - internal notes as notes (never shown to the customer);
//   - Kustomer's status, tags, teams and owners as source_meta.
// It never calls ingestInbound() or reply(), so nothing is routed, assigned, notified or sent,
// and it never touches an existing live conversation or changes an existing contact. Re-running
// it is a no-op: conversations are unique by (source, source_id) and messages/notes by
// external_id. Every row carries the import run id, so a run can be rolled back; contacts it
// created are recorded in kustomer_contacts.
import * as K from './normalize.js';
import * as svc from '../inbox/service.js';
import { TARGETS } from './dryrun.js';

export const KUSTOMER_IMPORT_ENABLED = true;

const CHANNEL = (c) => (c === 'email' ? 'email' : c === 'sms' ? 'sms' : c === 'voice' ? 'voice' : 'chat');

export function createKustomerImporter({ db, vault, enabled = KUSTOMER_IMPORT_ENABLED }) {
  const guard = () => {
    if (!enabled) throw Object.assign(new Error('Importing Kustomer history is not enabled. It needs approval and a code change (KUSTOMER_IMPORT_ENABLED).'), { status: 403 });
  };
  const one = async (q, sql, p) => (await q.query(sql, p)).rows[0] || null;
  const remember = (q, contactId, plan, kind, runId) =>
    q.query('INSERT INTO kustomer_contacts (contact_id, kustomer_customer_id, kind, import_run_id) VALUES ($1,$2,$3,$4) ON CONFLICT (contact_id) DO NOTHING', [contactId, plan.kustomer_customer_id, kind, runId]);

  // A contact for a Launch27 customer or cleaner: theirs if they have one, else one made once.
  async function linkedContact(q, plan, kc, runId, col, id, role) {
    const existing = await one(q, `SELECT id FROM contacts WHERE ${col} = $1 ORDER BY id LIMIT 1`, [id]);
    if (existing) return { id: Number(existing.id) };
    const made = await svc.createContact(q, { name: kc?.name || null, roles: [role], [col]: id });
    await remember(q, made.id, plan, role, runId);
    return { id: Number(made.id) };
  }

  // A profile for someone Launch27 doesn't know: one an import already made for this Kustomer
  // customer, else a contact with one of their emails (or, with no email, a phone), else a new one.
  async function profile(q, plan, kc, runId) {
    const before = await one(q, "SELECT contact_id FROM kustomer_contacts WHERE kustomer_customer_id = $1 AND kind IN ('profile', 'internal') ORDER BY contact_id LIMIT 1", [plan.kustomer_customer_id]);
    if (before) return { id: Number(before.contact_id) };
    const emails = kc?.emails.map((e) => e.email) || [];
    const phones = kc?.phones || [];
    for (const [kind, values] of emails.length ? [['email', emails]] : [['phone', phones]]) {
      for (const v of values) {
        const [hit] = await svc.contactsByIdentity(q, kind, v);
        if (hit) return { id: Number(hit.id) };
      }
    }
    // Only identities no other contact has: live messages from a shared number keep their match.
    const free = [];
    for (const [kind, values] of [['email', emails], ['phone', phones]]) {
      for (const v of values) if (!(await svc.contactsByIdentity(q, kind, v)).length) free.push({ kind, value: v });
    }
    const made = await svc.createContact(q, { name: kc?.name || emails[0] || phones[0] || null, roles: ['customer'], identities: free });
    await remember(q, made.id, plan, plan.match === 'internal' ? 'internal' : 'profile', runId);
    return { id: Number(made.id), created: true };
  }

  async function contactFor(q, plan, kc, runId) {
    if (!TARGETS.includes(plan.target)) throw new Error('This plan was made before every conversation got a customer: run the dry run again');
    if (plan.target !== 'new' && plan.contact_id && (await one(q, 'SELECT 1 FROM contacts WHERE id = $1', [plan.contact_id]))) return { id: Number(plan.contact_id) };
    if (plan.target === 'customer' && plan.l27_customer_id) return linkedContact(q, plan, kc, runId, 'l27_customer_id', Number(plan.l27_customer_id), 'customer');
    if (plan.target === 'cleaner' && plan.l27_team_id) return linkedContact(q, plan, kc, runId, 'l27_team_id', Number(plan.l27_team_id), 'cleaner');
    return profile(q, plan, kc, runId); // new, or a contact that has gone since the dry run
  }

  async function records(q, conversationId) {
    const rows = (await q.query('SELECT kind, kustomer_id, data FROM kustomer_records WHERE conversation_id = $1', [conversationId])).rows;
    const out = { conv: null, messages: [], notes: [] };
    for (const r of rows) {
      const raw = vault.open(r.data);
      if (r.kind === 'conversation') out.conv = K.conversation(raw);
      else if (r.kind === 'message') out.messages.push(K.message(raw));
      else if (r.kind === 'note') out.notes.push(K.note(raw));
    }
    out.messages.sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
    return out;
  }

  // The Kustomer customers behind these plans (name, emails, phones), for contacts the import makes.
  async function customers(q, ids) {
    const out = new Map();
    if (!ids.length) return out;
    for (const r of (await q.query("SELECT kustomer_id, data FROM kustomer_records WHERE kind = 'customer' AND kustomer_id = ANY($1::text[])", [ids])).rows) out.set(r.kustomer_id, K.customer(vault.open(r.data)));
    return out;
  }

  /** Import planned conversations (rows of kustomer_plan_conversations with their customer's plan). */
  // `dedupe(messages)` (optional) returns an isDuplicate function; it runs before the batch's
  // transaction, so it may read the database (one connection: no reads inside the transaction).
  async function importBatch(runId, plans, { isDuplicate = null, dedupe = null } = {}) {
    guard();
    const result = { conversations: 0, messages: 0, notes: 0, skipped: 0, profiles: 0 };
    const loaded = new Map();
    for (const plan of plans) if (plan.action === 'new') loaded.set(plan.kustomer_conversation_id, await records(db, plan.kustomer_conversation_id));
    const people = await customers(db, [...new Set(plans.filter((p) => p.action === 'new').map((p) => p.kustomer_customer_id).filter(Boolean))]);
    const dup = isDuplicate || (dedupe ? await dedupe([...loaded.values()].flatMap((r) => r.messages)) : () => false);
    await db.tx(async (q) => {
      const contacts = new Map(); // Kustomer customer -> contact, within this batch
      for (const plan of plans) {
        if (plan.action !== 'new') {
          result.skipped++;
          continue;
        }
        const { conv, messages, notes } = loaded.get(plan.kustomer_conversation_id);
        // Missing, or imported before: skipped before a contact is found or made for it.
        if (!conv || (await one(q, "SELECT 1 FROM conversations WHERE source = 'kustomer' AND source_id = $1", [conv.id]))) {
          result.skipped++;
          continue;
        }
        let contactId = contacts.get(plan.kustomer_customer_id);
        if (!contactId) {
          const c = await contactFor(q, plan, people.get(plan.kustomer_customer_id), runId);
          if (c.created) result.profiles++;
          contactId = c.id;
          contacts.set(plan.kustomer_customer_id, contactId);
        }
        const last = messages.at(-1);
        const firstIn = messages.find((m) => m.direction === 'in');
        const theirs = firstIn?.from || last?.to?.[0] || null;
        const row = (
          await q.query(
            `INSERT INTO conversations (contact_id, channel, their_identity, subject, status, done_at, priority, routed_by,
                                        last_message_at, last_preview, created_at, updated_at, source, source_id, source_meta, import_run_id)
             VALUES ($1,$2,$3,$4,'done',$5,3,'Imported from Kustomer',COALESCE($6::timestamptz, now()),$7,COALESCE($8::timestamptz, now()),COALESCE($6::timestamptz, now()),'kustomer',$9,$10::jsonb,$11)
             ON CONFLICT (source, source_id) WHERE source IS NOT NULL DO NOTHING RETURNING id`,
            [
              contactId,
              CHANNEL(conv.channels[0] || last?.channel),
              theirs,
              conv.subject,
              conv.ended_at || last?.sent_at || conv.updated_at || conv.created_at,
              last?.sent_at || conv.updated_at || conv.created_at,
              (last?.body || '').slice(0, 160),
              conv.created_at || messages[0]?.sent_at,
              conv.id,
              JSON.stringify({ kustomer_customer_id: plan.kustomer_customer_id, status: conv.status, tags: conv.tags, assigned_users: conv.assigned_users, assigned_teams: conv.assigned_teams, queue: conv.queue, priority: conv.priority, match: plan.match }),
              runId,
            ],
          )
        ).rows[0];
        if (!row) {
          result.skipped++; // imported before
          continue;
        }
        result.conversations++;
        for (const m of messages) {
          if (dup(m)) continue; // already in the live inbox (Gmail / SMS since the cut-over)
          const res = await q.query(
            `INSERT INTO messages (conversation_id, kind, direction, channel, from_addr, to_addr, subject, body, delivery_state, external_id, meta, created_at)
             VALUES ($1,'message',$2,$3,$4,$5,$6,$7,'historical',$8,$9::jsonb,COALESCE($10::timestamptz, now())) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
            [row.id, m.direction || 'in', CHANNEL(m.channel), m.from, m.to[0] || null, m.subject, m.body, `kustomer:msg:${m.id}`, JSON.stringify({ historical: true, source: 'kustomer', kustomer_id: m.id, preview_only: m.preview_only || undefined, attachments: m.attachments.length ? m.attachments : undefined, message_id: m.email_message_id || undefined, import_run_id: runId }), m.sent_at],
          );
          result.messages += res.rows.length;
        }
        for (const n of notes) {
          const res = await q.query(
            `INSERT INTO messages (conversation_id, kind, body, external_id, meta, created_at)
             VALUES ($1,'note',$2,$3,$4::jsonb,COALESCE($5::timestamptz, now())) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
            [row.id, n.body, `kustomer:note:${n.id}`, JSON.stringify({ historical: true, source: 'kustomer', kustomer_id: n.id, import_run_id: runId }), n.created_at],
          );
          result.notes += res.rows.length;
        }
      }
    });
    return result;
  }

  return {
    importBatch,
    /**
     * Undo one import run: its conversations (and, by cascade, their messages and notes), then
     * the new profiles it made that are left empty and still not linked to Launch27. Contacts
     * made for Launch27 customers and cleaners stay, as do profiles that have since received
     * live messages or been linked by an agent.
     */
    async rollback(runId) {
      guard();
      return db.tx(async (q) => {
        const res = await q.query("DELETE FROM conversations WHERE source = 'kustomer' AND import_run_id = $1 RETURNING id", [runId]);
        const gone = await q.query(
          `DELETE FROM contacts c USING kustomer_contacts k
           WHERE k.contact_id = c.id AND k.import_run_id = $1 AND k.kind IN ('profile', 'internal')
             AND c.l27_customer_id IS NULL AND c.l27_team_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = c.id)
           RETURNING c.id`,
          [runId],
        );
        return { conversations: res.rows.length, profiles: gone.rows.length };
      });
    },
    /** Compare what was imported with what the dry run planned (read-only). */
    async reconcile(dryRunId, runId) {
      const planned = (await db.query("SELECT kustomer_conversation_id AS id, messages - duplicate_messages AS messages, notes FROM kustomer_plan_conversations WHERE run_id = $1 AND action = 'new'", [dryRunId])).rows;
      const got = new Map(
        (
          await db.query(
            `SELECT c.source_id AS id, count(*) FILTER (WHERE m.kind = 'message')::int AS messages, count(*) FILTER (WHERE m.kind = 'note')::int AS notes
             FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id WHERE c.source = 'kustomer' AND c.import_run_id = $1 GROUP BY c.source_id`,
            [runId],
          )
        ).rows.map((r) => [r.id, r]),
      );
      const missing = planned.filter((p) => !got.has(p.id)).map((p) => p.id);
      const different = planned.filter((p) => got.has(p.id) && (got.get(p.id).notes !== p.notes || got.get(p.id).messages < p.messages)).map((p) => p.id);
      // Every imported conversation must be on someone's Story.
      const withoutCustomer = Number((await db.query("SELECT count(*)::int AS n FROM conversations WHERE source = 'kustomer' AND import_run_id = $1 AND contact_id IS NULL", [runId])).rows[0].n);
      return { planned: planned.length, imported: got.size, missing, different, without_customer: withoutCustomer };
    },
  };
}

const sanitizeError = (err) => String(err?.message || err).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[address]').slice(0, 300);

/**
 * The import job behind the page: imports a completed dry run's plan (conversations marked
 * 'new') in batches, one transaction each, recording progress after every batch. It can be
 * stopped and resumed (a restart leaves it stopped), and a finished or stopped run can be
 * rolled back. Progress and counts live in kustomer_import_runs.
 */
export function createKustomerImportJob({ db, importer, dedupe = null, log = () => {}, batch = 50 }) {
  let running = null;
  let stopRequested = false;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0] || null;
  const get = (id) => one('SELECT * FROM kustomer_import_runs WHERE id = $1', [id]);

  async function execute(runId) {
    const run = await get(runId);
    let cursor = run.cursor || '';
    for (;;) {
      if (stopRequested) {
        await db.query("UPDATE kustomer_import_runs SET status = 'stopped', updated_at = now() WHERE id = $1", [runId]);
        log('info', 'kustomer import stopped', { run: runId });
        return;
      }
      const plans = (
        await db.query(
          `SELECT c.*, p.contact_id, p.target, p.l27_team_id FROM kustomer_plan_conversations c
           JOIN kustomer_plan_customers p ON p.run_id = c.run_id AND p.kustomer_customer_id = c.kustomer_customer_id
           WHERE c.run_id = $1 AND c.action = 'new' AND c.kustomer_conversation_id > $2
           ORDER BY c.kustomer_conversation_id LIMIT $3`,
          [run.dry_run_id, cursor, batch],
        )
      ).rows;
      if (!plans.length) break;
      const r = await importer.importBatch(runId, plans, { dedupe });
      cursor = plans.at(-1).kustomer_conversation_id;
      await db.query(
        `UPDATE kustomer_import_runs SET cursor = $2, processed = processed + $3, conversations = conversations + $4, messages = messages + $5,
                notes = notes + $6, skipped = skipped + $7, profiles = profiles + $8, batches = batches + 1, updated_at = now() WHERE id = $1`,
        [runId, cursor, plans.length, r.conversations, r.messages, r.notes, r.skipped, r.profiles],
      );
    }
    const rec = await importer.reconcile(run.dry_run_id, runId);
    const summary = { planned: rec.planned, imported: rec.imported, missing: rec.missing.length, different: rec.different.length, without_customer: rec.without_customer, missing_ids: rec.missing.slice(0, 50), different_ids: rec.different.slice(0, 50) };
    await db.query("UPDATE kustomer_import_runs SET status = 'completed', reconcile = $2::jsonb, finished_at = now(), updated_at = now() WHERE id = $1", [runId, JSON.stringify(summary)]);
    log('info', 'kustomer import completed', { run: runId, conversations: rec.imported });
  }

  function launch(runId) {
    stopRequested = false;
    running = execute(runId)
      .catch(async (err) => {
        log('error', 'kustomer import failed', { run: runId, error: sanitizeError(err) });
        await db.query("UPDATE kustomer_import_runs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [runId, sanitizeError(err)]).catch(() => {});
      })
      .finally(() => {
        running = null;
      });
  }

  const busy = () => {
    if (running) throw Object.assign(new Error('An import is already running'), { status: 409 });
  };

  return {
    isActive: () => !!running,
    wait: () => running || Promise.resolve(),
    get,
    list: async () => (await db.query('SELECT r.*, u.name AS created_by_name FROM kustomer_import_runs r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.id DESC LIMIT 20')).rows,
    async start(user, dryRun) {
      busy();
      const planned = (await one("SELECT count(*)::int AS n FROM kustomer_plan_conversations WHERE run_id = $1 AND action = 'new'", [dryRun.id])).n;
      const run = await one('INSERT INTO kustomer_import_runs (dry_run_id, planned, created_by) VALUES ($1, $2, $3) RETURNING *', [dryRun.id, planned, user?.id ?? null]);
      log('info', 'kustomer import started', { run: run.id, dry_run: dryRun.id, planned, by: user?.id ?? null });
      launch(run.id);
      return run;
    },
    async stop(id) {
      const run = await get(id);
      if (!run) throw Object.assign(new Error('No such import'), { status: 404 });
      if (run.status !== 'running') throw Object.assign(new Error('This import is not running'), { status: 409 });
      stopRequested = true;
      return { ...run, stopping: true };
    },
    async resume(id) {
      busy();
      const run = await get(id);
      if (!run) throw Object.assign(new Error('No such import'), { status: 404 });
      if (!['stopped', 'failed'].includes(run.status)) throw Object.assign(new Error('Only a stopped or failed import can be resumed'), { status: 409 });
      await db.query("UPDATE kustomer_import_runs SET status = 'running', last_error = NULL, updated_at = now() WHERE id = $1", [id]);
      launch(id);
      return get(id);
    },
    async rollback(user, id) {
      busy();
      const run = await get(id);
      if (!run) throw Object.assign(new Error('No such import'), { status: 404 });
      if (run.status === 'rolled_back') throw Object.assign(new Error('Already rolled back'), { status: 409 });
      const r = await importer.rollback(id);
      await db.query("UPDATE kustomer_import_runs SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = $2, rolled_back_conversations = $3, rolled_back_profiles = $4, updated_at = now() WHERE id = $1", [id, user?.id ?? null, r.conversations, r.profiles]);
      log('info', 'kustomer import rolled back', { run: id, conversations: r.conversations, profiles: r.profiles, by: user?.id ?? null });
      return get(id);
    },
    async recover() {
      await db.query("UPDATE kustomer_import_runs SET status = 'stopped', last_error = 'Interrupted by a server restart. Resume it to carry on.', updated_at = now() WHERE status = 'running'");
    },
  };
}
