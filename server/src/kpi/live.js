// Live KPI connectors (production). Read-only by construction: Launch27 is only ever sent
// the login call and GET requests, and Kustomer complaints are read from the complaint
// tables the Complaint playbook already fills (src/complaints/), so this file talks to
// Kustomer not at all.
//
// Launch27 is pulled once a day into kpi_snapshots: the whole history from the first KPI
// month the first time and once a week, and otherwise only the recent window (bookings from
// 120 days back to 60 days ahead), merged into what is stored. Refreshes are idempotent: the
// same pull twice leaves the same snapshot.
import { readFileSync } from 'node:fs';
import { addDays, localDate } from '../schedule/rules.js';
import { KPI_RULES, KPI_SOURCES } from './config.js';
import { createGoogleBusinessKpi } from './google.js';
import { createSyftKpi } from './syft.js';

const LOCAL = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** ISO timestamp -> local calendar string 'YYYY-MM-DDTHH:MM' (Toronto), or null. */
export function localStamp(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(LOCAL.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const nameOf = (u) => String(u?.name || [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.company_name || '').trim();
const same = (a, b) => !!a && !!b && a.toLowerCase().replace(/\s+/g, ' ').trim() === b.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * One Launch27 booking -> the row the calc layer reads. `tt` is its time-tracking record and
 * `fb` the same booking from the with_feedback list, when there is one.
 * Who cancelled: Launch27 gives only a name, so it is the client when that name is the
 * client's own, and staff otherwise.
 */
export function normalizeBooking(b, tt = null, fb = null) {
  const customer = nameOf(b.user) || 'Customer';
  const c = b.cancellation || null;
  const tracks = [...(b.time_tracking || []), ...((tt?.teams || []).map((t) => t.time_tracking).filter(Boolean))];
  const checkins = tracks.map((t) => t.checkin_at).filter(Boolean).sort();
  const feedback = fb?.feedback || b.feedback || null;
  const start = localStamp(b.service_date);
  return {
    id: Number(b.id),
    customer_id: b.user?.id != null ? Number(b.user.id) : null,
    customer,
    date: start?.slice(0, 10) || null,
    start,
    created_at: localStamp(b.created_at),
    frequency: b.frequency?.name || '',
    completed: b.active !== false && !c && (b.completed === true || checkins.length > 0),
    cleaner: (b.teams || []).map((t) => String(t.title || '').trim()).filter(Boolean).join(', ') || null,
    checkin_at: localStamp(checkins[0]),
    rating: feedback && feedback.rating != null ? Number(feedback.rating) : null,
    rated_at: feedback ? localStamp(feedback.rated_at)?.slice(0, 10) || start?.slice(0, 10) || null : null,
    rating_comment: null, // comments stay in Launch27; the scorecard only needs the rating
    location: b.location?.name || null,
    cancellation: c || b.active === false ? { at: localStamp(c?.date) || start, reason: String(c?.reason || '').slice(0, 300), by: same(c?.cancelled_by?.name, customer) ? 'customer' : 'staff', by_name: c?.cancelled_by?.name || null, type: c?.type ? String(c.type).slice(0, 80) : null } : null,
  };
}

export function createLaunch27Kpi({ db, config, fetchImpl = fetch, syncBearer, brand, log = { info() {}, warn() {}, error() {} }, now = () => Date.now(), rules = KPI_RULES }) {
  const RECENT_BACK = 120;
  const AHEAD = 60;
  let running = null;
  let lastAttempt = 0;
  let memo = null; // { taken_at, bookings }

  // The only request this connector can make to Launch27 besides the login: a GET.
  const get = async (bearer, path, query) => {
    const u = new URL(config.l27BaseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    const res = await fetchImpl(u.toString(), { method: 'GET', headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Launch27 ${path} returned ${res.status}`);
    return res.json();
  };
  const pullRange = async (bearer, path, from, to, query = {}) => {
    const out = new Map();
    for (let a = from; a <= to; a = addDays(a, 30)) {
      const b = addDays(a, 29) < to ? addDays(a, 29) : to;
      for (let page = 0; page < 300; page++) {
        const rows = await get(bearer, path, { ...query, from: a, to: b, limit: 100, offset: page * 100 });
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) if (r.id != null) out.set(Number(r.id), r);
        if (rows.length < 100) break;
      }
    }
    return out;
  };
  const inBrand = (b) => !brand.locations || brand.locations.test(b.location || '');

  async function stored() {
    const row = (await db.query('SELECT taken_at, full_pull_at, data FROM kpi_snapshots WHERE brand = $1 AND source = $2', [brand.key, 'launch27'])).rows[0];
    return row ? { taken_at: new Date(row.taken_at).toISOString(), full_pull_at: row.full_pull_at ? new Date(row.full_pull_at).toISOString() : null, bookings: row.data.bookings || [] } : null;
  }
  async function logRun(status, rows, note) {
    await db
      .query(
        `INSERT INTO kpi_refresh_log (brand, source, refresh_day, status, row_count, note) VALUES ($1,'launch27',$2,$3,$4,$5)
         ON CONFLICT (brand, source, refresh_day) DO UPDATE SET status = EXCLUDED.status, row_count = EXCLUDED.row_count, note = EXCLUDED.note, finished_at = now()`,
        [brand.key, localDate(now()), status, rows, note],
      )
      .catch((err) => log.warn('kpi refresh log failed', { error: err.message }));
  }

  // `bearer`: the signed-in person's own Launch27 login, when they click "Refresh Launch27 now".
  // Without one, the read-only sync login is used.
  async function sync({ full = false, bearer = null } = {}) {
    lastAttempt = now();
    try {
      bearer = bearer || (await syncBearer());
      if (!bearer) throw new Error('No Launch27 login for the KPI refresh (set L27_SYNC_EMAIL and L27_SYNC_PASSWORD)');
      const today = localDate(now());
      const prev = await stored();
      const whole = full || !prev || !prev.full_pull_at || now() - Date.parse(prev.full_pull_at) > 7 * 86_400_000;
      const from = whole ? `${rules.firstMonth}-01` : addDays(today, -RECENT_BACK);
      const to = addDays(today, AHEAD);
      const active = await pullRange(bearer, '/v1/staff/bookings', from, to);
      const cancelled = await pullRange(bearer, '/v1/staff/bookings', from, to, { filter: 'cancelled' });
      const tracking = await pullRange(bearer, '/v1/staff/bookings/time_tracking', from, today);
      const rated = await pullRange(bearer, '/v1/staff/bookings', from, today, { options: 'with_feedback' });
      const fresh = new Map();
      for (const [id, b] of active) fresh.set(id, normalizeBooking(b, tracking.get(id), rated.get(id)));
      // A cancelled booking wins over an active copy of the same id.
      for (const [id, b] of cancelled) fresh.set(id, normalizeBooking({ ...b, active: false }, null, null));
      // Keep stored bookings older than the window; inside it, what Launch27 returned is the truth.
      const kept = whole ? [] : prev.bookings.filter((b) => b.date < from);
      const bookings = [...kept, ...[...fresh.values()].filter((b) => b.date && inBrand(b))];
      const taken = new Date(now()).toISOString();
      await db.query(
        `INSERT INTO kpi_snapshots (brand, source, taken_at, full_pull_at, data) VALUES ($1,'launch27',$2,$3,$4::jsonb)
         ON CONFLICT (brand, source) DO UPDATE SET taken_at = EXCLUDED.taken_at, full_pull_at = EXCLUDED.full_pull_at, data = EXCLUDED.data`,
        [brand.key, taken, whole ? taken : prev.full_pull_at, JSON.stringify({ bookings })],
      );
      memo = { taken_at: taken, bookings };
      await logRun('ok', bookings.length, whole ? 'full history' : `last ${RECENT_BACK} days`);
      // Which cancellation types Launch27 sent (values and counts only), to check seriesCancelPattern against.
      const types = {};
      for (const x of bookings) if (x.cancellation) types[x.cancellation.type || '(none)'] = (types[x.cancellation.type || '(none)'] || 0) + 1;
      log.info('kpi launch27 refreshed', { bookings: bookings.length, full: whole, cancel_types: JSON.stringify(types).slice(0, 600) });
      return { bookings: bookings.length, full: whole };
    } catch (err) {
      // The previous snapshot stays; the tile goes Stale once it is over 48 hours old.
      await logRun('failed', 0, String(err.message).slice(0, 300));
      log.error('kpi launch27 refresh failed', { error: err.message });
      throw err;
    }
  }
  const start = (opts) => {
    if (!running) running = sync(opts).catch(() => null).finally(() => (running = null));
    return running;
  };

  return {
    key: 'launch27',
    label: KPI_SOURCES.launch27.label,
    mode: 'live',
    async pull() {
      if (!memo) memo = await stored();
      return memo ? { refreshed_at: memo.taken_at, bookings: memo.bookings } : { refreshed_at: null, note: 'first refresh has not finished yet' };
    },
    // Not part of the connector's read surface for the scorecard: the daily job.
    job: {
      start,
      running: () => !!running,
      // Once a day after 5 am Toronto, at boot if never run, and no more than every 30 minutes after a failure.
      async maybeRun() {
        if (running || now() - lastAttempt < 30 * 60_000) return;
        // No sync login configured: only "Refresh Launch27 now" (the person's own login) can run it.
        if (config.l27Mode === 'live' && !(config.l27SyncEmail && config.l27SyncPassword)) return;
        const s = memo || (await stored());
        const hour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now())));
        if (!s || (localDate(Date.parse(s.taken_at)) < localDate(now()) && hour >= 5)) start();
      },
    },
  };
}

/** Kustomer complaint objects, from the tables the Complaint playbook keeps (read-only SELECTs). */
export function createKustomerKpi({ db, brand }) {
  return {
    key: 'kustomer',
    label: KPI_SOURCES.kustomer.label,
    mode: 'live',
    async pull() {
      // The playbook reads Kustomer in runs, each covering a date window. Freshness is the last
      // run that finished; coverage is the windows that have been read.
      const runs = (await db.query("SELECT window_from::text AS f, window_to::text AS t, finished_at FROM complaint_runs WHERE status IN ('done', 'partial') AND window_from IS NOT NULL AND window_to IS NOT NULL ORDER BY window_from")).rows;
      if (!runs.length) return { refreshed_at: null, note: 'the Complaint playbook has not finished reading Kustomer yet' };
      const last = runs.map((r) => new Date(r.finished_at).getTime()).filter(Number.isFinite).sort((x, y) => y - x)[0];
      const coverage = [];
      for (const r of runs) {
        const w = { from: r.f.slice(0, 10), to: r.t.slice(0, 10) };
        const prev = coverage[coverage.length - 1];
        // Windows that touch or overlap are one covered stretch.
        if (prev && w.from <= addDays(prev.to, 1)) prev.to = w.to > prev.to ? w.to : prev.to;
        else coverage.push(w);
      }
      const rows = (
        await db.query(
          `SELECT id, l27_customer_id, l27_booking_id, customer_name, customer_email, opened_at, channel, category
             FROM complaint_cases WHERE source = 'kustomer' AND brand = $1 AND merged_into IS NULL AND excluded_at IS NULL ORDER BY id`,
          [brand.complaintBrand || 'residential'],
        )
      ).rows;
      return {
        refreshed_at: new Date(last).toISOString(),
        complaintCoverage: coverage,
        complaints: rows.map((r) => ({
          id: Number(r.id),
          // Not every complaint is matched to a Launch27 client; fall back to the email so one client still dedupes.
          customer_id: r.l27_customer_id != null ? Number(r.l27_customer_id) : `email:${r.customer_email || r.id}`,
          customer: r.customer_name || 'Client',
          booking_id: r.l27_booking_id != null ? Number(r.l27_booking_id) : null,
          date: localStamp(new Date(r.opened_at).toISOString()).slice(0, 10),
          channel: r.channel || null,
          summary: r.category || '',
        })),
      };
    },
  };
}

/**
 * Google reviews from a one-off Google Takeout export kept in the repository (dates and star
 * ratings only), until the Business Profile API is connected. Not live: the tile says so, and
 * months after the export's last review read "No data".
 */
export function createGoogleExportKpi({ brand, load = loadGoogleExport }) {
  return {
    key: 'google',
    label: KPI_SOURCES.google.label,
    mode: 'export',
    async pull() {
      const data = brand.googleExport ? load(brand.googleExport) : null;
      if (!data?.reviews?.length) return { refreshed_at: null, note: 'Google Business Profile is not connected yet' };
      return {
        refreshed_at: `${data.exported_on}T12:00:00.000Z`,
        note: `Export of ${data.exported_on}, not live`,
        static: true,
        reviews: data.reviews.map(([date, rating], i) => ({ id: i + 1, date, rating, reviewer: '', comment: '' })),
        reviewBaseline: { count: 0, avg: 0 },
        reviewsExport: { exported_on: data.exported_on, reviews_to: data.reviews_to },
      };
    },
  };
}
function loadGoogleExport(name) {
  try {
    return JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

const notConnected = (key, note) => ({ key, label: KPI_SOURCES[key].label, mode: 'not_connected', pull: async () => ({ refreshed_at: null, note }) });

/** Production connectors: Launch27, Kustomer, Syft (Gmail) and Google live; QuickBooks not connected yet. */
export function createLiveKpiConnectors({ db, config, fetchImpl, syncBearer, brand, log, now, gmail = null }) {
  const syft = gmail && config.kpiSyftMailbox && brand.syftReport ? createSyftKpi({ db, gmail, mailbox: config.kpiSyftMailbox, brand, log, now }) : notConnected('syft', gmail ? 'no mailbox set for the Syft report (KPI_SYFT_MAILBOX)' : 'Gmail is not connected');
  return [
    createLaunch27Kpi({ db, config, fetchImpl, syncBearer, brand, log, now }),
    createKustomerKpi({ db, brand }),
    config.gbp ? createGoogleBusinessKpi({ db, gbp: config.gbp, secret: config.sessionSecret, brand, fallback: createGoogleExportKpi({ brand }), fetchImpl, log, now }) : createGoogleExportKpi({ brand }),
    notConnected('qbo', 'QuickBooks is not connected yet'),
    syft,
  ];
}
