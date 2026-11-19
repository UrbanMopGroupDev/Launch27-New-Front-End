// KPI scorecard service: pulls each source through its read-only connector, hands the
// normalized dataset to the calc layer (calc.js) and serves the scorecard and drill-downs.
import { localDate } from '../schedule/rules.js';
import { indexDataset, scorecard, drill, lastClosedMonth, addMonths, monthOf, monthsBetween, monthLabel } from './calc.js';
import { KPI_BRANDS, KPI_RULES } from './config.js';
import { createKpiConnectors } from './connectors.js';
import { createLiveKpiConnectors } from './live.js';

export const KPI_OUTAGES = { launch27_stale: 'Launch27 stale (61 h)', kustomer_missing: 'Kustomer not connected', qbo_missing: 'QuickBooks not connected', syft_missing: 'Syft report not received', google_stale: 'Google stale (75 h)' };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Who sees the scorecard. Dev and QA (synthetic data): everyone. Production: only the
// logins in KPI_EMAILS, because it carries financial figures.
export function canSeeKpi(config, email) {
  if (!config.production) return true;
  return (config.kpiEmails || []).includes(String(email || '').toLowerCase());
}

export function createKpi({ db, config, log = { info() {}, warn() {}, error() {} }, now = () => Date.now(), fetchImpl = fetch, syncBearer = null, connectors = null }) {
  const synthetic = !config.production;
  // Dev and QA: synthetic. Production: live Launch27 and Kustomer; the rest read "No data" until connected.
  connectors = connectors || (synthetic || !syncBearer ? createKpiConnectors({ synthetic }) : createLiveKpiConnectors({ db, config, fetchImpl, syncBearer, brand: KPI_BRANDS[0], log, now }));
  const jobs = connectors.map((c) => c.job).filter(Boolean);
  let cache = null;
  let manualVersion = 0;

  async function load(brandKey, outage) {
    const today = localDate(now());
    const ds = { brand: brandKey, sources: {}, bookings: [], complaints: [], reviews: null, reviewBaseline: null, ocr: { qbo: [], syft: [] }, manualReviews: {} };
    const pulled = [];
    for (const c of connectors) {
      let got;
      try {
        got = await c.pull({ brand: brandKey, today, now: now(), outage });
      } catch (err) {
        // A failed pull is a missing source, never a zero.
        log.error('kpi source pull failed', { source: c.key, error: err.message });
        got = { refreshed_at: null, note: 'refresh failed' };
      }
      pulled.push([c, got]);
      ds.sources[c.key] = { refreshed_at: got.refreshed_at || null, note: got.note || null };
      if (got.bookings) ds.bookings = got.bookings;
      if (got.complaints) ds.complaints = got.complaints;
      if (got.reviews) (ds.reviews = got.reviews), (ds.reviewBaseline = got.reviewBaseline);
      if (got.qbo) ds.ocr.qbo = got.qbo;
      if (got.syft) ds.ocr.syft = got.syft;
    }
    // Nothing new from any source since the last build: reuse it. Synthetic refresh times move
    // with the clock, so there the day is the version.
    const version = synthetic ? '' : pulled.map(([c, got]) => `${c.key}:${got.refreshed_at || got.note || ''}:${(got.complaints || []).length}`).join(',');
    const key = `${brandKey}|${today}|${outage || ''}|${manualVersion}|${version}`;
    if (cache?.key === key) return synthetic ? cache : { ...cache, ds: { ...cache.ds, sources: ds.sources } };
    for (const [c, got] of pulled) {
      if (c.job) continue; // a connector with its own daily job logs its own refreshes
      const rows = (got.bookings || got.complaints || got.reviews || got.qbo || got.syft || []).length;
      // Idempotent: one log row per source per day, updated in place.
      await db.query(
        `INSERT INTO kpi_refresh_log (brand, source, refresh_day, status, row_count, note) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (brand, source, refresh_day) DO UPDATE SET status = EXCLUDED.status, row_count = EXCLUDED.row_count, note = EXCLUDED.note, finished_at = now()`,
        [brandKey, c.key, today, got.refreshed_at ? 'ok' : got.note === 'refresh failed' ? 'failed' : 'missing', rows, outage ? `outage preview: ${outage}` : got.note || null],
      ).catch((err) => log.warn('kpi refresh log failed', { error: err.message }));
    }
    if (synthetic) {
      const manual = (await db.query('SELECT month, new_reviews, avg_rating, alltime_avg, alltime_count FROM kpi_manual_reviews WHERE brand = $1', [brandKey])).rows;
      for (const m of manual) ds.manualReviews[m.month] = { new_reviews: Number(m.new_reviews), avg_rating: Number(m.avg_rating), alltime_avg: Number(m.alltime_avg), alltime_count: Number(m.alltime_count) };
    }
    cache = { key, today, ix: indexDataset(ds), ds };
    return cache;
  }

  const brandOf = (key) => {
    const b = KPI_BRANDS.find((x) => x.key === (key || KPI_BRANDS[0].key));
    if (!b) throw fail(400, 'Unknown brand');
    return b;
  };
  const cleanOutage = (o) => (synthetic && o && o in KPI_OUTAGES ? o : null);
  function pickMonth(month, today) {
    const last = addMonths(monthOf(today), -1);
    const def = lastClosedMonth(today, KPI_RULES);
    if (month == null || month === '') return { month: def, last, def };
    if (!MONTH.test(month) || month < KPI_RULES.firstMonth || month > last) throw fail(400, `Month must be between ${KPI_RULES.firstMonth} and ${last}`);
    return { month, last, def };
  }

  return {
    async scorecard({ brand, month, mode, outage } = {}) {
      const b = brandOf(brand);
      const o = cleanOutage(outage);
      const c = await load(b.key, o);
      const m = pickMonth(month, c.today);
      const card = scorecard(c.ix, { brand: b, month: m.month, mode: mode === 't12' ? 't12' : 'month', now: now(), today: c.today });
      return {
        ...card,
        today: c.today,
        env: config.appEnv,
        synthetic,
        brands: KPI_BRANDS.map((x) => ({ key: x.key, name: x.name, detail: x.detail })),
        months: monthsBetween(KPI_RULES.firstMonth, m.last).reverse().map((x) => ({ value: x, label: monthLabel(x) })),
        default_month: m.def,
        sources: connectors.map((x) => ({ key: x.key, label: x.label, mode: x.mode, ...c.ds.sources[x.key] })),
        outage: o,
        outages: synthetic ? KPI_OUTAGES : null,
        refresh: { available: jobs.length > 0, running: jobs.some((j) => j.running()) },
        manual_reviews: synthetic ? { can_enter: true, entry: c.ds.manualReviews[m.month] || null } : { can_enter: false, entry: null },
      };
    },
    async drill({ brand, month, mode, kpi, outage } = {}) {
      const b = brandOf(brand);
      if (!['ocr', 'churn', 'over_cancel', 'fulfilment', 'complaints', 'reviews'].includes(kpi) || !b.kpis.includes(kpi === 'over_cancel' ? 'churn' : kpi)) throw fail(400, 'Unknown KPI');
      const c = await load(b.key, cleanOutage(outage));
      const m = pickMonth(month, c.today);
      return drill(c.ix, { kpi, month: m.month, mode: mode === 't12' ? 't12' : 'month', today: c.today });
    },
    // Daily read-only refresh of the live sources (worker tick), and "Refresh now".
    async maybeRun() {
      for (const j of jobs) await j.maybeRun();
    },
    refresh({ bearer = null } = {}) {
      if (!jobs.length) throw fail(409, 'Nothing to refresh here: this environment uses synthetic data');
      for (const j of jobs) j.start({ bearer });
      return { running: true };
    },
    // Manual Google review entry: development and QA only.
    async saveManualReviews({ brand, month, entry, email }) {
      if (!synthetic) throw fail(403, 'Manual entry is not available in production');
      const b = brandOf(brand);
      const m = pickMonth(month, localDate(now())).month;
      const n = { new_reviews: Number(entry?.new_reviews), avg_rating: Number(entry?.avg_rating), alltime_avg: Number(entry?.alltime_avg), alltime_count: Number(entry?.alltime_count) };
      if (!Number.isInteger(n.new_reviews) || n.new_reviews < 0 || !Number.isInteger(n.alltime_count) || n.alltime_count < n.new_reviews) throw fail(400, 'Review counts must be whole numbers, and the all-time count at least the new reviews');
      if (![n.avg_rating, n.alltime_avg].every((x) => x >= 1 && x <= 5)) throw fail(400, 'Ratings must be between 1 and 5');
      await db.query(
        `INSERT INTO kpi_manual_reviews (brand, month, new_reviews, avg_rating, alltime_avg, alltime_count, entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (brand, month) DO UPDATE SET new_reviews = EXCLUDED.new_reviews, avg_rating = EXCLUDED.avg_rating, alltime_avg = EXCLUDED.alltime_avg, alltime_count = EXCLUDED.alltime_count, entered_by = EXCLUDED.entered_by, entered_at = now()`,
        [b.key, m, n.new_reviews, n.avg_rating, n.alltime_avg, n.alltime_count, email || null],
      );
      manualVersion += 1;
      return { month: m, entry: n };
    },
    async clearManualReviews({ brand, month }) {
      if (!synthetic) throw fail(403, 'Manual entry is not available in production');
      await db.query('DELETE FROM kpi_manual_reviews WHERE brand = $1 AND month = $2', [brandOf(brand).key, String(month)]);
      manualVersion += 1;
      return { month, entry: null };
    },
  };
}
