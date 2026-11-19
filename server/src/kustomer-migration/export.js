// The Kustomer export: a resumable background job that copies every accessible customer and
// their conversations, messages, internal notes and attachment details into kustomer_records,
// encrypted. Read-only on Kustomer (GET only) and on the live inbox (not touched at all).
//
//   phase customers      page through GET /v1/customers, saving each page and a checkpoint
//   phase conversations  per customer: conversations, then each one's messages and notes, and
//                        attachment details; one customer at a time per worker, 3 workers
//
// A "catch-up" job does the same for customers active since a date and skips conversations
// whose updatedAt hasn't changed since the last export.
import { digestOf } from './vault.js';
import * as K from './normalize.js';

const ACTIVE = ['queued', 'running', 'paused'];
const MAX_ATTEMPTS = 3;
// Masks emails and phone numbers in error text kept for admins.
export const sanitize = (err) =>
  String(err?.message || err)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]')
    .slice(0, 300);

export class MigrationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A database handle that may only write to the migration's own tables. */
export function migrationDb(db) {
  const check = (sql) => {
    const s = String(sql).trim();
    if (/^(insert\s+into|update|delete\s+from)\s+/i.test(s) && !/^(insert\s+into|update|delete\s+from)\s+kustomer_/i.test(s)) throw new Error('The Kustomer migration attempted to write outside its own tables');
    if (/^(truncate|alter|drop|create)\b/i.test(s)) throw new Error('The Kustomer migration attempted a schema change');
  };
  return {
    query: (sql, p) => (check(sql), db.query(sql, p)),
    tx: (fn) => db.tx((q) => fn({ query: (sql, p) => (check(sql), q.query(sql, p)) })),
  };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]);
      }
    }),
  );
}

export function createKustomerExport({ db, vault, getSource, log = () => {}, concurrency = 3, batch = 12 }) {
  const store = migrationDb(db);
  const running = new Map();
  const one = async (sql, p) => (await store.query(sql, p)).rows[0] || null;

  // Insert or update one record; returns 1 when it was new or changed.
  async function upsert(q, jobId, kind, raw, fields) {
    const digest = digestOf(raw);
    const res = await q.query(
      `INSERT INTO kustomer_records (kind, kustomer_id, customer_id, conversation_id, source_created_at, source_updated_at, channel, direction, digest, data, job_id, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (kind, kustomer_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, conversation_id = EXCLUDED.conversation_id,
         source_created_at = EXCLUDED.source_created_at, source_updated_at = EXCLUDED.source_updated_at, channel = EXCLUDED.channel,
         direction = EXCLUDED.direction, digest = EXCLUDED.digest, data = EXCLUDED.data, job_id = EXCLUDED.job_id, fetched_at = now()
       WHERE kustomer_records.digest <> EXCLUDED.digest
       RETURNING kustomer_id`,
      [kind, String(raw.id), fields.customer_id ?? null, fields.conversation_id ?? null, fields.created_at ?? null, fields.updated_at ?? null, fields.channel ?? null, fields.direction ?? null, digest, vault.seal(raw), jobId],
    );
    return res.rows.length;
  }

  const lastActivity = (rec) => {
    const a = rec.attributes || {};
    return [a.lastActivityAt, a.lastConversationAt, a.lastMessageAt, a.updatedAt, a.modifiedAt].filter(Boolean).sort().at(-1) || null;
  };

  async function customersStep(job, src) {
    const page = await src.customersPage(job.next_link);
    const since = job.kind === 'catchup' ? job.scope.since : null;
    return store.tx(async (q) => {
      for (const rec of page.records) {
        const c = K.customer(rec);
        await upsert(q, job.id, 'customer', rec, { customer_id: c.id, created_at: c.created_at, updated_at: c.updated_at });
        if (since && !(lastActivity(rec) >= since)) continue; // catch-up: untouched since
        await q.query('INSERT INTO kustomer_export_customers (job_id, customer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [job.id, c.id]);
      }
      return (
        await q.query("UPDATE kustomer_export_jobs SET next_link = $2, pages = pages + 1, phase = $3, requests = $4, updated_at = now() WHERE id = $1 RETURNING *", [job.id, page.next, page.next ? 'customers' : 'conversations', src.requests()])
      ).rows[0];
    });
  }

  async function exportCustomer(job, src, customerId) {
    const convs = await src.conversations(customerId);
    const items = [];
    for (const rec of convs) {
      const conv = K.conversation(rec);
      if (job.kind === 'catchup') {
        const known = await one("SELECT source_updated_at FROM kustomer_records WHERE kind = 'conversation' AND kustomer_id = $1", [conv.id]);
        if (known?.source_updated_at && conv.updated_at && new Date(known.source_updated_at).toISOString() === conv.updated_at) continue;
      }
      const msgs = await src.messages(conv.id);
      const notes = await src.notes(conv.id);
      const atts = [];
      if (job.scope.attachments !== false) {
        for (const id of [...new Set(msgs.flatMap((m) => K.message(m).attachments))]) {
          const seen = await one("SELECT 1 FROM kustomer_records WHERE kind = 'attachment' AND kustomer_id = $1", [id]);
          if (seen) continue;
          const a = await src.attachment(id).catch((err) => (err.status === 404 ? null : Promise.reject(err)));
          if (a) atts.push({ rec: a, message: msgs.find((m) => K.message(m).attachments.includes(id)) });
        }
      }
      items.push({ rec, conv, msgs, notes, atts });
    }
    await store.tx(async (q) => {
      for (const { rec, conv, msgs, notes, atts } of items) {
        await upsert(q, job.id, 'conversation', rec, { customer_id: customerId, conversation_id: conv.id, created_at: conv.created_at, updated_at: conv.updated_at, channel: conv.channels[0] || null });
        for (const m of msgs) {
          const x = K.message(m);
          await upsert(q, job.id, 'message', m, { customer_id: customerId, conversation_id: conv.id, created_at: x.created_at, updated_at: x.sent_at, channel: x.channel, direction: x.direction });
        }
        for (const n of notes) {
          const x = K.note(n);
          await upsert(q, job.id, 'note', n, { customer_id: customerId, conversation_id: conv.id, created_at: x.created_at });
        }
        for (const { rec: a, message } of atts) await upsert(q, job.id, 'attachment', a, { customer_id: customerId, conversation_id: conv.id, created_at: message ? K.message(message).created_at : null });
      }
      await q.query("UPDATE kustomer_export_customers SET state = 'done', error = NULL WHERE job_id = $1 AND customer_id = $2", [job.id, customerId]);
    });
  }

  async function conversationsStep(job, src) {
    const rows = (await store.query("SELECT customer_id, attempts FROM kustomer_export_customers WHERE job_id = $1 AND state = 'pending' ORDER BY customer_id LIMIT $2", [job.id, batch])).rows;
    if (!rows.length) return one("UPDATE kustomer_export_jobs SET phase = 'done', requests = $2, updated_at = now() WHERE id = $1 RETURNING *", [job.id, src.requests()]);
    await mapLimit(rows, concurrency, async (row) => {
      try {
        await exportCustomer(job, src, row.customer_id);
      } catch (err) {
        if (err.status === 401 || err.status === 403) throw err; // the key lost access: stop (resumable)
        const attempts = row.attempts + 1;
        const state = err.status === 404 ? 'skipped' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        await store.query('UPDATE kustomer_export_customers SET attempts = $3, state = $4, error = $5 WHERE job_id = $1 AND customer_id = $2', [job.id, row.customer_id, attempts, state, sanitize(err)]);
      }
    });
    return one('UPDATE kustomer_export_jobs SET requests = $2, updated_at = now() WHERE id = $1 RETURNING *', [job.id, src.requests()]);
  }

  const status = async (id) => (await one('SELECT status FROM kustomer_export_jobs WHERE id = $1', [id]))?.status;

  async function execute(id) {
    const got = await getSource();
    if (!got) throw new MigrationError(409, 'Kustomer is not connected here');
    let job = await one("UPDATE kustomer_export_jobs SET status = 'running', started_at = COALESCE(started_at, now()), last_error = NULL, updated_at = now() WHERE id = $1 AND status IN ('queued','running') RETURNING *", [id]);
    if (!job) return;
    while (job.phase !== 'done') {
      if ((await status(id)) !== 'running') return;
      job = job.phase === 'customers' ? await customersStep(job, got.source) : await conversationsStep(job, got.source);
    }
    await store.query("UPDATE kustomer_export_jobs SET status = 'completed', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'", [id]);
    log('info', 'kustomer export completed', { job: id, requests: got.source.requests() });
  }

  function start(id) {
    if (running.has(id)) return running.get(id);
    const p = execute(id)
      .catch(async (err) => {
        log('error', 'kustomer export failed', { job: id, error: sanitize(err) });
        await store.query("UPDATE kustomer_export_jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'running'", [id, sanitize(err)]).catch(() => {});
      })
      .finally(() => running.delete(id));
    running.set(id, p);
    return p;
  }

  async function detail(id) {
    const job = await one('SELECT * FROM kustomer_export_jobs WHERE id = $1', [id]);
    if (!job) throw new MigrationError(404, 'No such export');
    const states = Object.fromEntries((await store.query('SELECT state, count(*)::int AS n FROM kustomer_export_customers WHERE job_id = $1 GROUP BY state', [id])).rows.map((r) => [r.state, r.n]));
    const errors = (await store.query("SELECT customer_id, state, attempts, error FROM kustomer_export_customers WHERE job_id = $1 AND state IN ('failed','skipped') ORDER BY customer_id LIMIT 200", [id])).rows;
    return { ...job, customers: { pending: 0, done: 0, failed: 0, skipped: 0, ...states }, errors };
  }

  return {
    async recover() {
      await store.query("UPDATE kustomer_export_jobs SET status = 'paused', last_error = 'Interrupted by a server restart. Resume to continue.', updated_at = now() WHERE status IN ('queued','running')");
    },
    detail,
    latest: async () => one('SELECT id FROM kustomer_export_jobs ORDER BY id DESC LIMIT 1'),
    list: async () => (await store.query('SELECT id, kind, status, phase, source, scope, created_at, finished_at, last_error FROM kustomer_export_jobs ORDER BY id DESC LIMIT 10')).rows,
    async create(user, { kind = 'full', since = null, attachments = true } = {}) {
      const got = await getSource();
      if (!got) throw new MigrationError(409, 'Kustomer is not connected here (KUSTOMER_API_KEY)');
      if (kind === 'catchup' && !/^\d{4}-\d{2}-\d{2}/.test(String(since || ''))) throw new MigrationError(400, 'A catch-up export needs a "since" date (YYYY-MM-DD)');
      const job = await store.tx(async (q) => {
        const busy = (await q.query("SELECT id FROM kustomer_export_jobs WHERE status IN ('queued','running','paused') LIMIT 1")).rows[0];
        if (busy) throw new MigrationError(409, `Export #${busy.id} is still open: finish or cancel it first`);
        return (await q.query('INSERT INTO kustomer_export_jobs (kind, source, scope, created_by) VALUES ($1,$2,$3::jsonb,$4) RETURNING *', [kind === 'catchup' ? 'catchup' : 'full', got.kind, JSON.stringify({ since: kind === 'catchup' ? since : null, attachments: attachments !== false }), user?.id ?? null])).rows[0];
      });
      log('info', 'kustomer export started', { job: job.id, kind: job.kind, by: user?.email });
      start(job.id);
      return detail(job.id);
    },
    async pause(id) {
      if (!(await one("UPDATE kustomer_export_jobs SET status = 'paused', updated_at = now() WHERE id = $1 AND status IN ('queued','running') RETURNING id", [id]))) throw new MigrationError(409, 'Only a running export can be paused');
      await running.get(Number(id));
      return detail(id);
    },
    async resume(id) {
      // Paused or failed, or finished with customers that kept failing (resuming retries just those).
      const resumable = await one(
        `UPDATE kustomer_export_jobs SET status = 'queued', last_error = NULL, finished_at = NULL, updated_at = now()
         WHERE id = $1 AND (status IN ('paused','failed') OR (status = 'completed' AND EXISTS (SELECT 1 FROM kustomer_export_customers c WHERE c.job_id = $1 AND c.state = 'failed')))
         RETURNING id`,
        [id],
      );
      if (!resumable) throw new MigrationError(409, 'Only a paused or failed export, or one with failed customers, can be resumed');
      await store.query("UPDATE kustomer_export_customers SET state = 'pending', attempts = 0, error = NULL WHERE job_id = $1 AND state = 'failed'", [id]);
      await store.query("UPDATE kustomer_export_jobs SET phase = 'conversations' WHERE id = $1 AND phase = 'done'", [id]);
      start(Number(id));
      return detail(id);
    },
    async cancel(id) {
      if (!(await one("UPDATE kustomer_export_jobs SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND status IN ('queued','running','paused','failed') RETURNING id", [id]))) throw new MigrationError(409, 'This export has already finished');
      await running.get(Number(id));
      return detail(id);
    },
    wait: (id) => running.get(Number(id)) || Promise.resolve(),
    isActive: async () => !!(await one(`SELECT 1 FROM kustomer_export_jobs WHERE status = ANY($1::text[]) LIMIT 1`, [ACTIVE])),
  };
}
