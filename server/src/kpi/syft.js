// Syft management report (the monthly PDF the bookkeeper emails). Read-only: the mailbox is
// searched for these reports only, with the app's read-only Gmail access, and nothing is
// labelled, moved or sent. The report states the Operational Cost Ratio on its Financial
// Health Scorecard page; that stated figure and Total Income are all that is taken from it.
import { localDate } from '../schedule/rules.js';
import { KPI_SOURCES } from './config.js';

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const monthKey = (label) => {
  const m = String(label || '').trim().match(/^([A-Za-z]{3})[a-z]*\.? (\d{4})$/);
  return m && MONTHS[m[1].toLowerCase()] ? `${m[2]}-${MONTHS[m[1].toLowerCase()]}` : null;
};

/** PDF bytes -> its text as lines, top to bottom, with the columns of a row kept on one line. */
export async function pdfLines(bytes) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const lines = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const rows = new Map();
    for (const item of (await page.getTextContent()).items) {
      if (!item.str || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3; // items on one row share a baseline, give or take
      (rows.get(y) || rows.set(y, []).get(y)).push({ x: item.transform[4], s: item.str });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) lines.push(rows.get(y).sort((a, b) => a.x - b.x).map((i) => i.s.trim()).join('  '));
  }
  return lines;
}

/**
 * The report's own figures for its month and the month before:
 * { month, ocr_pct, income, prev: { month, ocr_pct } } or null when the page is not found.
 */
export function parseSyftReport(lines) {
  const at = lines.findIndex((l) => /^Operational Cost Ratio\b/i.test(l.trim()));
  if (at < 0) return null;
  const pct = [...lines[at].matchAll(/(-?[\d.]+)\s*%/g)].map((m) => Number(m[1]));
  // The column headings above it: "Aug 2026  Jul 2026  Variance  Variance (%)".
  let cols = null;
  let income = null;
  for (let i = at - 1; i >= 0 && i > at - 60; i--) {
    if (income == null) {
      const t = lines[i].trim().match(/^Total Income\s+\$?\s*([\d,]+(?:\.\d+)?)/i);
      if (t) income = Number(t[1].replace(/,/g, ''));
    }
    const h = lines[i].match(/([A-Z][a-z]{2,8} \d{4})\s+([A-Z][a-z]{2,8} \d{4})\s+Variance/);
    if (h) {
      cols = [monthKey(h[1]), monthKey(h[2])];
      break;
    }
  }
  if (!cols?.[0] || !Number.isFinite(pct[0]) || pct[0] <= 0 || pct[0] >= 200) return null;
  return { month: cols[0], ocr_pct: pct[0], income, prev: cols[1] && Number.isFinite(pct[1]) ? { month: cols[1], ocr_pct: pct[1] } : null };
}

const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const pdfParts = (payload, out = []) => {
  if (payload?.filename && payload.body?.attachmentId && /\.pdf$/i.test(payload.filename)) out.push({ filename: payload.filename, attachmentId: payload.body.attachmentId });
  for (const p of payload?.parts || []) pdfParts(p, out);
  return out;
};

/**
 * Live Syft connector. `gmail` is the app's Gmail client (read-only scope); `mailbox` is the
 * one mailbox that receives the reports. Each report email is read once; a revised report in
 * the same thread replaces the earlier figure for its month.
 */
export function createSyftKpi({ db, gmail, mailbox, brand, log = { info() {}, warn() {}, error() {} }, now = () => Date.now(), readPdf = pdfLines }) {
  const QUERY = 'subject:"Management Report as at" has:attachment filename:pdf newer_than:1100d';
  let running = null;
  let lastAttempt = 0;
  let memo = null;

  async function stored() {
    const row = (await db.query('SELECT taken_at, data FROM kpi_snapshots WHERE brand = $1 AND source = $2', [brand.key, 'syft'])).rows[0];
    return row ? { taken_at: new Date(row.taken_at).toISOString(), reports: row.data.reports || {}, seen: row.data.seen || {} } : null;
  }
  async function logRun(status, rows, note) {
    await db
      .query(
        `INSERT INTO kpi_refresh_log (brand, source, refresh_day, status, row_count, note) VALUES ($1,'syft',$2,$3,$4,$5)
         ON CONFLICT (brand, source, refresh_day) DO UPDATE SET status = EXCLUDED.status, row_count = EXCLUDED.row_count, note = EXCLUDED.note, finished_at = now()`,
        [brand.key, localDate(now()), status, rows, note],
      )
      .catch((err) => log.warn('kpi refresh log failed', { error: err.message }));
  }

  async function sync() {
    lastAttempt = now();
    try {
      const prev = (await stored()) || { reports: {}, seen: {} };
      const reports = { ...prev.reports };
      const seen = { ...prev.seen };
      const ids = [];
      let pageToken;
      do {
        const page = await gmail.search(mailbox, QUERY, { max: 100, pageToken });
        ids.push(...page.ids);
        pageToken = page.next;
      } while (pageToken && ids.length < 1000);
      let read = 0;
      for (const id of ids) {
        if (seen[id]) continue;
        const msg = await gmail.message(mailbox, id);
        const received = new Date(Number(msg.internalDate) || now()).toISOString();
        const mine = pdfParts(msg.payload).filter((p) => brand.syftReport.test(p.filename));
        seen[id] = mine.length ? 'read' : 'no report for this brand';
        for (const part of mine) {
          try {
            const att = await gmail.attachment(mailbox, id, part.attachmentId);
            const got = parseSyftReport(await readPdf(b64(att.data)));
            if (!got) {
              seen[id] = 'report page not found';
              log.warn('kpi syft: no Operational Cost Ratio line in report', { file: part.filename });
              continue;
            }
            read += 1;
            // A later email (a revision) wins for its month.
            if (!reports[got.month] || reports[got.month].received_at <= received) reports[got.month] = { month: got.month, ocr_pct: got.ocr_pct, income: got.income, received_at: received, file: part.filename };
            // The report also restates the month before; use it only if that month has no report of its own.
            if (got.prev && !reports[got.prev.month]) reports[got.prev.month] = { month: got.prev.month, ocr_pct: got.prev.ocr_pct, income: null, received_at: received, file: `${part.filename} (previous-month column)`, restated: true };
          } catch (err) {
            delete seen[id]; // try again next time
            log.warn('kpi syft: could not read a report', { file: part.filename, error: err.message });
          }
        }
      }
      const taken = new Date(now()).toISOString();
      await db.query(
        `INSERT INTO kpi_snapshots (brand, source, taken_at, data) VALUES ($1,'syft',$2,$3::jsonb)
         ON CONFLICT (brand, source) DO UPDATE SET taken_at = EXCLUDED.taken_at, data = EXCLUDED.data`,
        [brand.key, taken, JSON.stringify({ reports, seen })],
      );
      memo = { taken_at: taken, reports, seen };
      await logRun('ok', Object.keys(reports).length, `${read} new report${read === 1 ? '' : 's'} read`);
      log.info('kpi syft refreshed', { months: Object.keys(reports).length, new_reports: read });
      return { months: Object.keys(reports).length, read };
    } catch (err) {
      await logRun('failed', 0, String(err.message).slice(0, 300));
      log.error('kpi syft refresh failed', { error: err.message });
      throw err;
    }
  }
  const start = () => {
    if (!running) running = sync().catch(() => null).finally(() => (running = null));
    return running;
  };

  return {
    key: 'syft',
    label: KPI_SOURCES.syft.label,
    mode: 'live',
    async pull() {
      if (!memo) memo = await stored();
      return memo ? { refreshed_at: memo.taken_at, syft: Object.values(memo.reports).sort((a, b) => (a.month < b.month ? -1 : 1)) } : { refreshed_at: null, note: 'the mailbox has not been read yet' };
    },
    job: {
      start,
      running: () => !!running,
      // Once a day (reports arrive monthly), at boot if never run, at most every 30 minutes after a failure.
      async maybeRun() {
        if (running || now() - lastAttempt < 30 * 60_000) return;
        const s = memo || (await stored());
        if (!s || localDate(Date.parse(s.taken_at)) < localDate(now())) start();
      },
    },
  };
}
