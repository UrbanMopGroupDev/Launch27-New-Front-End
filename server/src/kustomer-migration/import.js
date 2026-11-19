// The live import of Kustomer history (approved). Anyone signed in can start it from the
// Kustomer migration page; it imports the latest completed dry run's plan in batches, can be
// stopped and resumed, and a run can be rolled back. KUSTOMER_IMPORT_ENABLED switches it off.
//
// What it does, per planned conversation (from a dry run), in one transaction per batch:
//   - one historical conversation: status done, original dates, no queue, owner, reply target
//     or SLA clock, linked to the matched customer's support contact (created only when the
//     Launch27 customer has none yet: never a second contact for the same customer);
//   - its messages with original timestamps and direction, delivery_state 'historical';
//   - internal notes as notes (never shown to the customer);
//   - Kustomer's status, tags, teams and owners as source_meta.
// It never calls ingestInbound() or reply(), so nothing is routed, assigned, notified or sent,
// and it never touches an existing live conversation. Re-running it is a no-op: conversations
// are unique by (source, source_id) and messages/notes by external_id. Every row carries the
// import run id, so a run can be rolled back.
import * as K from './normalize.js';

export const KUSTOMER_IMPORT_ENABLED = true;

const CHANNEL = (c) => (c === 'email' ? 'email' : c === 'sms' ? 'sms' : c === 'voice' ? 'voice' : 'chat');

export function createKustomerImporter({ db, vault, enabled = KUSTOMER_IMPORT_ENABLED }) {
  const guard = () => {
    if (!enabled) throw Object.assign(new Error('Importing Kustomer history is not enabled. It needs approval and a code change (KUSTOMER_IMPORT_ENABLED).'), { status: 403 });
  };

  async function contactFor(q, plan) {
    if (plan.contact_id && (await q.query('SELECT 1 FROM contacts WHERE id = $1', [plan.contact_id])).rows.length) return Number(plan.contact_id);
    if (plan.match !== 'confident' || !plan.l27_customer_id) return null; // unmatched/uncertain: not linked to anyone
    const existing = (await q.query('SELECT id FROM contacts WHERE l27_customer_id = $1 ORDER BY id LIMIT 1', [plan.l27_customer_id])).rows[0];
    if (existing) return Number(existing.id);
    return Number((await q.query("INSERT INTO contacts (roles, l27_customer_id) VALUES ('[\"customer\"]'::jsonb, $1) RETURNING id", [plan.l27_customer_id])).rows[0].id);
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

  /** Import planned conversations (rows of kustomer_plan_conversations with their customer's plan). */
  // `dedupe(messages)` (optional) returns an isDuplicate function; it runs before the batch's
  // transaction, so it may read the database (one connection: no reads inside the transaction).
  async function importBatch(runId, plans, { isDuplicate = null, dedupe = null } = {}) {
    guard();
    const result = { conversations: 0, messages: 0, notes: 0, skipped: 0 };
    const loaded = new Map();
    for (const plan of plans) if (plan.action === 'new') loaded.set(plan.kustomer_conversation_id, await records(db, plan.kustomer_conversation_id));
    const dup = isDuplicate || (dedupe ? await dedupe([...loaded.values()].flatMap((r) => r.messages)) : () => false);
    await db.tx(async (q) => {
      for (const plan of plans) {
        if (plan.action !== 'new') {
          result.skipped++;
          continue;
        }
        const { conv, messages, notes } = loaded.get(plan.kustomer_conversation_id);
        if (!conv) {
          result.skipped++;
          continue;
        }
        const contactId = await contactFor(q, plan);
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
    /** Undo one import run: its conversations (and, by cascade, their messages and notes). */
    async rollback(runId) {
      guard();
      const res = await db.query("DELETE FROM conversations WHERE source = 'kustomer' AND import_run_id = $1 RETURNING id", [runId]);
      return { conversations: res.rows.length };
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
      return { planned: planned.length, imported: got.size, missing, different };
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
          `SELECT c.*, p.contact_id FROM kustomer_plan_conversations c
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
                notes = notes + $6, skipped = skipped + $7, batches = batches + 1, updated_at = now() WHERE id = $1`,
        [runId, cursor, plans.length, r.conversations, r.messages, r.notes, r.skipped],
      );
    }
    const rec = await importer.reconcile(run.dry_run_id, runId);
    const summary = { planned: rec.planned, imported: rec.imported, missing: rec.missing.length, different: rec.different.length, missing_ids: rec.missing.slice(0, 50), different_ids: rec.different.slice(0, 50) };
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
      await db.query("UPDATE kustomer_import_runs SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = $2, rolled_back_conversations = $3, updated_at = now() WHERE id = $1", [id, user?.id ?? null, r.conversations]);
      log('info', 'kustomer import rolled back', { run: id, conversations: r.conversations, by: user?.id ?? null });
      return get(id);
    },
    async recover() {
      await db.query("UPDATE kustomer_import_runs SET status = 'stopped', last_error = 'Interrupted by a server restart. Resume it to carry on.', updated_at = now() WHERE status = 'running'");
    },
  };
}
