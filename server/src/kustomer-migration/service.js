// The Kustomer migration as its page sees it (open to everyone signed in): connection test,
// export scope, the export job, the dry run and its report, and the import of a dry run's plan
// with progress, stop/resume and rollback. Production reads the real Kustomer (KUSTOMER_API_KEY,
// a key with read-only roles); development and QA read a synthetic Kustomer built from their
// synthetic Launch27, so real messages never reach them.
import { createKustomerClient } from '../complaints/sources/kustomer.js';
import { createVault } from './vault.js';
import { createKustomerSource } from './source.js';
import { createKustomerExport, MigrationError, migrationDb } from './export.js';
import { createKustomerDryRun } from './dryrun.js';
import { createSyntheticKustomer, generateKustomerData } from './synthetic.js';
import { KUSTOMER_IMPORT_ENABLED, createKustomerImporter, createKustomerImportJob } from './import.js';

const MATCHES = ['confident', 'review', 'ambiguous', 'conflict', 'unmatched', 'cleaner', 'internal'];
const csv = (v) => {
  const s = v == null ? '' : Array.isArray(v) ? v.join(' ') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function createKustomerMigration({ db, config, fetchImpl = fetch, l27Directory, ourDomains = [], log = () => {}, sourceOverride = null }) {
  const store = migrationDb(db);
  let vault = null;
  let vaultError = null;
  try {
    vault = createVault(config.kustomerExportKey);
  } catch (err) {
    vaultError = err.message;
  }

  let synthetic = null;
  async function getSource() {
    if (sourceOverride) return sourceOverride;
    if (config.production) {
      if (!config.kustomerApiKey) return null;
      return { kind: 'kustomer', source: createKustomerSource(createKustomerClient({ apiKey: config.kustomerApiKey, fetchImpl }), { rpm: config.kustomerExportRpm }) };
    }
    synthetic ||= (async () => {
      const { customers, teams } = await l27Directory();
      return { kind: 'synthetic', source: createKustomerSource(createSyntheticKustomer(generateKustomerData({ customers, teams })), { rpm: 6000 }) };
    })().catch((err) => {
      synthetic = null;
      throw err;
    });
    return synthetic;
  }

  const exporter = vault ? createKustomerExport({ db, vault, getSource, log }) : null;
  const dryRun = vault ? createKustomerDryRun({ db, vault, l27Directory, ourDomains, log }) : null;
  const importer = vault ? createKustomerImporter({ db, vault }) : null;
  const imports = vault ? createKustomerImportJob({ db, importer, dedupe: (messages) => dryRun.duplicates(messages), log }) : null;
  const need = () => {
    if (!vault) throw new MigrationError(409, `Kustomer migration is not set up: ${vaultError}`);
  };

  async function stored() {
    const rows = (await store.query('SELECT kind, count(*)::int AS n, min(source_created_at) AS oldest, max(source_created_at) AS newest FROM kustomer_records GROUP BY kind')).rows;
    return Object.fromEntries(rows.map((r) => [r.kind, { count: r.n, oldest: r.oldest, newest: r.newest }]));
  }

  return {
    async recover() {
      await exporter?.recover();
      await dryRun?.recover();
      await imports?.recover();
    },
    async overview() {
      const src = vault ? await getSource().catch(() => null) : null;
      const latest = exporter ? await exporter.latest() : null;
      const run = dryRun ? await dryRun.latest() : null;
      return {
        available: !!vault && !!src,
        source: src?.kind || null,
        setup_problem: vaultError || (!src ? 'KUSTOMER_API_KEY is not set in this environment' : null),
        import_enabled: KUSTOMER_IMPORT_ENABLED,
        stored: await stored(),
        export: latest ? await exporter.detail(latest.id) : null,
        exports: exporter ? await exporter.list() : [],
        dry_run: run,
        imports: imports ? await imports.list() : [],
      };
    },
    async testConnection() {
      need();
      const src = await getSource();
      if (!src) throw new MigrationError(409, 'KUSTOMER_API_KEY is not set in this environment');
      return { source: src.kind, ...(await src.source.testConnection()) };
    },
    /** What a full export would cover, from the first page of customers (no history is read). */
    async scope() {
      need();
      const src = await getSource();
      if (!src) throw new MigrationError(409, 'KUSTOMER_API_KEY is not set in this environment');
      const first = await src.source.customersPage(null);
      const total = first.meta?.totalCount ?? first.meta?.total ?? null;
      const years = first.records.map((r) => r.attributes?.createdAt).filter(Boolean).sort();
      return {
        source: src.kind,
        customers_total: total,
        customers_on_first_page: first.records.length,
        more_pages: !!first.next,
        oldest_on_first_page: years[0] || null,
        rate_per_minute: src.kind === 'kustomer' ? config.kustomerExportRpm : null,
        // About 1 request per customer, plus 2 per conversation (messages, notes).
        note: total ? `About ${total.toLocaleString('en-CA')} customers. Expect roughly 1 request per customer plus 2 per conversation.` : 'Kustomer did not report a total; the export counts as it goes.',
      };
    },
    startExport: (user, opts) => (need(), exporter.create(user, opts)),
    exportAction: async (id, action) => {
      need();
      if (!['pause', 'resume', 'cancel'].includes(action)) throw new MigrationError(404, 'Unknown action');
      return exporter[action](id);
    },
    async startDryRun(user) {
      need();
      if (await exporter.isActive()) throw new MigrationError(409, 'Wait for the export to finish (or pause it) before a dry run');
      if (imports.isActive()) throw new MigrationError(409, 'Wait for the import to finish (or stop it) before a dry run');
      if (!(await stored()).customer) throw new MigrationError(409, 'Export from Kustomer first');
      return dryRun.start(user);
    },
    /** Import the latest completed dry run's plan into the inbox, as history. */
    async startImport(user) {
      need();
      if (!KUSTOMER_IMPORT_ENABLED) throw new MigrationError(403, 'Importing Kustomer history is switched off');
      if (await exporter.isActive()) throw new MigrationError(409, 'Wait for the export to finish (or pause it) before importing');
      if (dryRun.isActive()) throw new MigrationError(409, 'Wait for the dry run to finish before importing');
      const run = await dryRun.latest();
      if (!run || run.status !== 'completed') throw new MigrationError(409, 'Run a dry run first: the import follows its plan');
      return imports.start(user, run);
    },
    importAction: async (user, id, action) => {
      need();
      if (action === 'stop') return imports.stop(id);
      if (action === 'resume') {
        if (await exporter.isActive()) throw new MigrationError(409, 'Wait for the export to finish (or pause it) before importing');
        return imports.resume(id);
      }
      if (action === 'rollback') return imports.rollback(user, id);
      throw new MigrationError(404, 'Unknown action');
    },
    async matches({ match = null, limit = 100, offset = 0 } = {}) {
      need();
      const run = await dryRun.latest();
      if (!run || run.status !== 'completed') return { run, rows: [] };
      const rows = (
        await store.query(
          `SELECT p.kustomer_customer_id, p.match, p.method, p.l27_customer_id, p.contact_id, p.candidates, p.reason, p.conversations, p.messages, p.notes
           FROM kustomer_plan_customers p WHERE p.run_id = $1 AND ($2::text IS NULL OR p.match = $2)
           ORDER BY (p.match = 'confident'), p.messages DESC, p.kustomer_customer_id LIMIT $3 OFFSET $4`,
          [run.id, MATCHES.includes(match) ? match : null, Math.min(500, limit), offset],
        )
      ).rows;
      // Names for the page (signed-in team only; never in the downloadable report).
      const names = new Map();
      const recs = (await store.query("SELECT kustomer_id, data FROM kustomer_records WHERE kind = 'customer' AND kustomer_id = ANY($1::text[])", [rows.map((r) => r.kustomer_customer_id)])).rows;
      for (const r of recs) {
        try {
          const a = vault.open(r.data).attributes || {};
          names.set(r.kustomer_id, a.name || a.displayName || null);
        } catch {
          // unreadable record: shown without a name
        }
      }
      return { run, rows: rows.map((r) => ({ ...r, name: names.get(r.kustomer_customer_id) || null })) };
    },
    async conversations(kustomerCustomerId) {
      need();
      const run = await dryRun.latest();
      if (!run) return [];
      return (await store.query('SELECT * FROM kustomer_plan_conversations WHERE run_id = $1 AND kustomer_customer_id = $2 ORDER BY first_at', [run.id, kustomerCustomerId])).rows;
    },
    /** The sanitized report: ids, decisions and counts only (no names, addresses or text). */
    async report() {
      need();
      const run = await dryRun.latest();
      if (!run || run.status !== 'completed') throw new MigrationError(409, 'Run a dry run first');
      const rows = (
        await store.query(
          `SELECT c.kustomer_conversation_id, c.kustomer_customer_id, p.match, p.method, c.l27_customer_id, c.action, c.channels, c.messages, c.notes,
                  c.duplicate_messages, c.preview_only_messages, c.first_at, c.last_at, COALESCE(c.reason, p.reason) AS reason
           FROM kustomer_plan_conversations c JOIN kustomer_plan_customers p ON p.run_id = c.run_id AND p.kustomer_customer_id = c.kustomer_customer_id
           WHERE c.run_id = $1 ORDER BY c.l27_customer_id NULLS LAST, c.first_at`,
          [run.id],
        )
      ).rows;
      const head = ['kustomer_conversation_id', 'kustomer_customer_id', 'match', 'method', 'l27_customer_id', 'action', 'channels', 'messages', 'notes', 'duplicate_messages', 'preview_only_messages', 'first_at', 'last_at', 'reason'];
      const lines = [head.join(',')].concat(rows.map((r) => head.map((h) => csv(r[h] instanceof Date ? r[h].toISOString() : r[h])).join(',')));
      return { filename: `kustomer-dry-run-${run.id}.csv`, csv: `${lines.join('\n')}\n`, summary: run.results };
    },
    /** Delete everything exported (and the dry runs). Kustomer itself, and anything already imported, are untouched. */
    async purge() {
      need();
      if (await exporter.isActive()) throw new MigrationError(409, 'Cancel the export first');
      if (imports.isActive() || dryRun.isActive()) throw new MigrationError(409, 'Wait for the import or dry run to finish first');
      await store.query('DELETE FROM kustomer_plan_conversations');
      await store.query('DELETE FROM kustomer_plan_customers');
      await store.query('DELETE FROM kustomer_dry_runs');
      await store.query('DELETE FROM kustomer_records');
      await store.query('DELETE FROM kustomer_export_jobs');
      return { purged: true };
    },
    _export: exporter,
    _dryRun: dryRun,
    _imports: imports,
    _vault: vault,
  };
}
