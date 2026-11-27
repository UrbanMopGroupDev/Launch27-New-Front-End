// Scheduling insights and cleaner reports. Nightly (after 4 am Toronto, and at boot if never
// run) a read-only sync pulls a year of bookings, check-in/out times, ratings and cleaner pay
// from Launch27 and stores them slimmed; reports are computed from that plus the planner's
// live schedule. Cleaner pay is only returned to admins.
import { addDays, daysBetween, localDate, mondayOf } from '../schedule/rules.js';
import { harmonizePartners } from '../commercial/partners.js';
import { clampRange, utilizationFacts, utilizationReport, withRecordedDays } from './utilization.js';
import { UTILIZATION } from './utilization-config.js';
import { FIELD_COLUMNS, fieldDaily, PERIODS, V2, findRecleans, cleanerRow, cleanerStats, emptyStats, mainBefore, flagsFor, indexVisits, median, outsideArea, pct, periodRange, regularClients, round1, sameCleaner, slimReportVisit, teamLong, timing, weeklySeries } from './compute.js';
import { CHANGE_LOG_START, CHURN, DROP_REASONS, RAISE_THRESHOLDS } from './raise-config.js';
import { createSheetReader, nameMatcher, parseAdjustmentRows } from './adjustments.js';
import { ladderOf, raiseReview, rateHistory, reliability, reliabilityWeeks, restrictiveTags, slackSummary } from './raise.js';


const DAYS_BACK = 365;
const HOUR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' });

export function createReports({ db, config, fetchImpl = fetch, schedule, log = { info() {}, warn() {}, error() {} }, now = () => Date.now() }) {
  let snap = null;
  let running = null;
  let lastAttempt = 0;
  const cache = new Map();
  const today = () => localDate(now());

  const get = async (bearer, path, query = {}) => {
    const u = new URL(config.l27BaseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    const res = await fetchImpl(u.toString(), { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
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
        for (const r of rows) out.set(r.id, r);
        if (rows.length < 100) break;
      }
    }
    return out;
  };
  async function syncBearer() {
    const creds = config.l27Mode === 'mock' ? { email: 'reports-sync@example.com', password: config.mockPassword || 'demo' } : config.l27SyncEmail && config.l27SyncPassword ? { email: config.l27SyncEmail, password: config.l27SyncPassword } : null;
    if (!creds) return null;
    const res = await fetchImpl(`${config.l27BaseUrl}/latest/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(creds), signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.bearer) throw new Error(`Launch27 login for the reports sync failed (${res.status})`);
    return body.bearer;
  }

  async function load() {
    if (snap) return snap;
    const row = (await db.query("SELECT taken_at, data FROM report_snapshots WHERE status = 'done' ORDER BY id DESC LIMIT 1")).rows[0];
    if (row) {
      const visits = harmonizePartners(row.data.visits);
      snap = { ...row.data, visits, taken_at: new Date(row.taken_at).toISOString(), byCustomer: indexVisits(visits) };
    }
    return snap;
  }

  async function sync({ bearer } = {}) {
    lastAttempt = now();
    try {
      bearer = bearer || (await syncBearer());
      if (!bearer) throw new Error('No Launch27 login for the reports sync (set L27_SYNC_EMAIL and L27_SYNC_PASSWORD)');
      const t = today();
      const from = addDays(t, -DAYS_BACK);
      const to = addDays(t, -1);
      const bookings = await pullRange(bearer, '/v1/staff/bookings', from, to);
      const tracking = await pullRange(bearer, '/v1/staff/bookings/time_tracking', from, to);
      const rated = await pullRange(bearer, '/v1/staff/bookings', from, to, { options: 'with_feedback' });
      const visits = [];
      for (const [id, b] of bookings) {
        if (b.active === false) continue;
        visits.push(slimReportVisit(b, tracking.get(id), rated.get(id)));
      }
      visits.splice(0, visits.length, ...harmonizePartners(visits));
      // Hospital programs were booked under the Ottawa (Residential) location until spring
      // 2026; they are Commercial work, so count them under the Commercial location.
      const commercialLoc = visits.find((v) => /commercial/i.test(v.location_name || ''))?.location_id || null;
      if (commercialLoc) for (const v of visits) if (v.partner_kind === 'program' && !/commercial|cornwall/i.test(v.location_name || '')) v.location_id = commercialLoc;
      const data = { today: t, from, to, visits };
      await db.tx(async (q) => {
        await q.query('INSERT INTO report_snapshots (data) VALUES ($1::jsonb)', [JSON.stringify(data)]);
        await q.query('DELETE FROM report_snapshots WHERE id NOT IN (SELECT id FROM report_snapshots ORDER BY id DESC LIMIT 2)');
      });
      snap = { ...data, taken_at: new Date(now()).toISOString(), byCustomer: indexVisits(visits) };
      cache.clear();
      await syncAdjustments().catch(() => null);
      log.info('reports updated', { visits: visits.length });
      return { visits: visits.length };
    } catch (err) {
      await db.query("INSERT INTO report_snapshots (status, error) VALUES ('failed', $1)", [String(err.message).slice(0, 500)]).catch(() => {});
      log.error('reports sync failed', { error: err.message });
      throw err;
    }
  }
  function start(opts) {
    if (!running) running = sync(opts).catch(() => null).finally(() => (running = null));
    return running;
  }
  // Rebuild once a day. Overnight with the sync login where one is set; otherwise (production has
  // none) when someone opens the reports and they are from before today, with that person's own
  // read-only Launch27 login, the way the planner keeps itself fresh. At most one try per 30 min.
  async function maybeRun({ bearer = null } = {}) {
    if (running || now() - lastAttempt < 30 * 60_000) return;
    const syncLogin = config.l27Mode === 'mock' || !!(config.l27SyncEmail && config.l27SyncPassword);
    if (!bearer && !syncLogin) return;
    const s = await load();
    const stale = !s || s.today < today();
    const due = bearer ? stale : stale && (!s || Number(HOUR.format(new Date(now()))) >= 4);
    if (due) {
      log.info('reports: building', { trigger: bearer ? 'viewer' : 'overnight', built_for: s?.today || null });
      start({ bearer: bearer || undefined });
    }
  }

  async function need() {
    const s = await load();
    if (!s) throw Object.assign(new Error('Reports have not been built yet. They build automatically overnight, or click "Refresh now".'), { status: 409 });
    return s;
  }

  // One brand's view (brand switcher): only visits at its Launch27 locations. null = both brands.
  const locKey = (locations) => (Array.isArray(locations) && locations.length ? [...new Set(locations.map(Number))].sort((a, b) => a - b).join(',') : '');
  const scopes = new Map();
  async function needScoped(locations) {
    const s = await need();
    const key = locKey(locations);
    if (!key) return s;
    const ck = `${s.taken_at}|${key}`;
    if (!scopes.has(ck)) {
      if (scopes.size > 20) scopes.clear();
      const ids = new Set(key.split(',').map(Number));
      const visits = s.visits.filter((v) => ids.has(Number(v.location_id)));
      scopes.set(ck, { ...s, visits, byCustomer: indexVisits(visits) });
    }
    return scopes.get(ck);
  }

  // Forward-looking numbers from the planner (next 4 weeks), per cleaner and by area.
  async function plannerView(locations = null) {
    try {
      const ov = await schedule.overview({ locations });
      const key = locKey(locations);
      if (key) {
        // Only cleaners working in this brand's locations (shared cleaners count in both).
        const ids = new Set(key.split(',').map(Number));
        ov.rows = ov.rows.filter((r) => !r.location_ids?.length || r.location_ids.some((id) => ids.has(Number(id))));
      }
      const util = new Map();
      for (const r of ov.rows) {
        const w = r.weeks.slice(0, 4);
        const booked = w.reduce((a, x) => a + x.booked, 0) / 4;
        const capacity = w.reduce((a, x) => a + x.capacity, 0) / 4;
        util.set(r.id, { booked, capacity, ac: (w[0]?.booked || 0) + (w[2]?.booked || 0), bd: (w[1]?.booked || 0) + (w[3]?.booked || 0), row: r });
      }
      return { ov, util };
    } catch {
      return { ov: null, util: new Map() };
    }
  }

  async function scheduling(period = '13w', { locations = null } = {}) {
    const s = await needScoped(locations);
    const key = `sched|${period}|${s.taken_at}|${locKey(locations)}`;
    if (cache.has(key)) return { ...cache.get(key), planner: await plannerHealth(period) };
    const { from, to } = periodRange(s.today, period);
    const sc = sameCleaner(s.visits, s.byCustomer, from, to);
    const { ov, util } = await plannerView(locations);
    const cleanerInfo = new Map((ov?.rows || []).map((r) => [r.id, r]));
    let tracked = 0, onTime = 0, long = 0, enroute = 0;
    const late = [];
    const km = [];
    const drives = [];
    let outside = 0, outsideN = 0;
    const perCleaner = new Map();
    for (const v of s.visits) {
      if (v.date < from || v.date > to) continue;
      for (const t of v.teams) {
        const tm = timing(v, t);
        if (!tm) continue;
        tracked++;
        if (tm.onTime) onTime++;
        else late.push(tm.late);
        if (tm.long) long++;
        if (tm.enroute) enroute++;
        const info = cleanerInfo.get(t.id);
        const out = outsideArea(v, info);
        if (out != null) {
          outsideN++;
          if (out) outside++;
        }
        const pc = perCleaner.get(t.id) || { id: t.id, name: info?.name || t.name, area: info?.area || null, km: [], tracked: 0, enroute: 0, outside: 0, outsideN: 0 };
        pc.tracked++;
        if (tm.enroute) pc.enroute++;
        if (out != null) {
          pc.outsideN++;
          if (out) pc.outside++;
        }
        if (tm.distance != null) {
          km.push(tm.distance);
          pc.km.push(tm.distance);
          drives.push({ cleaner: info?.name || t.name, cleaner_id: t.id, date: v.date, km: round1(tm.distance), area_out: !!out, customer: v.customer });
        }
        perCleaner.set(t.id, pc);
      }
    }
    // Hours filled by area (next 4 weeks).
    const areas = new Map();
    for (const [, u] of util) {
      if (!u.row.assignable) continue;
      const a = areas.get(u.row.area) || { area: u.row.area, booked: 0, capacity: 0 };
      a.booked += u.booked;
      a.capacity += u.capacity;
      areas.set(u.row.area, a);
    }
    const totalBooked = [...areas.values()].reduce((x, a) => x + a.booked, 0);
    const totalCap = [...areas.values()].reduce((x, a) => x + a.capacity, 0);
    const lopsided = [...util.values()].filter((u) => u.row.assignable && Math.abs(u.ac - u.bd) / 2 >= 8).map((u) => ({ cleaner_id: u.row.id, name: u.row.name, ac: round1(u.ac / 2), bd: round1(u.bd / 2) })).sort((a, b) => Math.abs(b.ac - b.bd) - Math.abs(a.ac - a.bd)).slice(0, 8);
    const out = {
      taken_at: s.taken_at, period, from, to,
      kpis: {
        same_cleaner: sc.share, same_cleaner_visits: sc.visits,
        on_time: pct(onTime, tracked), late_avg: late.length ? Math.round(late.reduce((a, b) => a + b, 0) / late.length) : null, check_ins: tracked,
        ran_long: pct(long, tracked),
        hours_filled: pct(totalBooked, totalCap),
        unassigned_visits: ov?.counts.unassigned_visits ?? null,
        km_per_visit: km.length ? round1(km.reduce((a, b) => a + b, 0) / km.length) : null,
        enroute: pct(enroute, tracked),
        outside_area: pct(outside, outsideN),
      },
      same_cleaner_series: sc.series,
      areas: [...areas.values()].map((a) => ({ area: a.area, filled: pct(a.booked, a.capacity), booked: round1(a.booked), capacity: round1(a.capacity) })).sort((a, b) => (b.filled ?? 0) - (a.filled ?? 0)),
      lopsided,
      longest_drives: drives.sort((a, b) => b.km - a.km).slice(0, 10),
      driving: [...perCleaner.values()].filter((p) => p.tracked >= 3).map((p) => ({ cleaner_id: p.id, name: p.name, area: p.area, km_per_visit: p.km.length ? round1(p.km.reduce((a, b) => a + b, 0) / p.km.length) : null, enroute: pct(p.enroute, p.tracked), outside_area: pct(p.outside, p.outsideN), visits: p.tracked })).sort((a, b) => (b.km_per_visit ?? 0) - (a.km_per_visit ?? 0)),
    };
    cache.set(key, out);
    return { ...out, planner: await plannerHealth(period) };
  }

  // How the planner's Changes to handle are being worked.
  async function plannerHealth(period) {
    const days = PERIODS[period] || 91;
    const rows = (await db.query("SELECT created_at, resolved_at, resolution FROM schedule_changes WHERE created_at > now() - ($1 || ' days')::interval", [String(days)])).rows;
    const handled = rows.filter((r) => r.resolution && ['fixed', 'fixed_rec', 'dismissed'].includes(r.resolution));
    const fixed = handled.filter((r) => r.resolution !== 'dismissed');
    const hours = handled.map((r) => (new Date(r.resolved_at) - new Date(r.created_at)) / 3_600_000);
    return {
      raised: rows.length,
      handled: handled.length,
      handled_share: pct(handled.length, rows.filter((r) => r.resolution !== 'gone').length),
      median_hours: hours.length ? round1(median(hours)) : null,
      recommended_share: pct(fixed.filter((r) => r.resolution === 'fixed_rec').length, fixed.length),
      expired: rows.filter((r) => r.resolution === 'past').length,
      open: rows.filter((r) => !r.resolved_at).length,
    };
  }

  // ---------- raise readiness: data kept in this app ----------
  // Drops (cleaner taken off a visit), complaints tagged with a cleaner, Google reviews.
  async function sideData(since) {
    const safe = (p) => p.then((r) => r.rows).catch((err) => {
      log.warn('raise readiness data unavailable', { error: err.message });
      return [];
    });
    const [drops, complaints, reviews, adj, adjSync] = await Promise.all([
      safe(db.query('SELECT id, cleaner_id, visit_key, booking_id, customer, visit_at, dropped_at, reason, source FROM cleaner_drops WHERE dropped_at >= $1 ORDER BY dropped_at', [`${since}T00:00:00Z`])),
      safe(db.query("SELECT id, cleaner_id, cleaner_name, subject, created_at, complaint FROM conversations WHERE cleaner_id IS NOT NULL AND complaint IS NOT NULL AND created_at >= $1 ORDER BY created_at DESC", [`${since}T00:00:00Z`])),
      safe(db.query('SELECT id, cleaner_id, review_date, reviewer, link, bonus_paid, created_at FROM cleaner_google_reviews ORDER BY review_date DESC')),
      safe(db.query('SELECT row_no, cleaner_name, kind, amount, on_date, customer, details, submitted_by FROM pay_adjustments WHERE valid AND on_date >= $1 ORDER BY on_date DESC', [since])),
      safe(db.query('SELECT synced_at, row_count, error FROM pay_adjustments_sync WHERE id = 1')),
    ]);
    const group = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const k = Number(r.cleaner_id);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const iso = (x) => (x instanceof Date ? x.toISOString() : String(x));
    const day = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
    return {
      drops: group(drops.map((d) => ({ ...d, id: Number(d.id), visit_at: iso(d.visit_at), dropped_at: iso(d.dropped_at), dropped_on: localDate(d.dropped_at), visit_date: localDate(d.visit_at) }))),
      complaints: group(complaints.map((c) => ({ id: Number(c.id), cleaner_id: Number(c.cleaner_id), subject: c.subject, date: localDate(c.created_at), outcome: c.complaint?.outcome || null, status: c.complaint?.status || null, booking_id: c.complaint?.booking_id ?? null }))),
      reviews: group(reviews.map((r) => ({ id: Number(r.id), cleaner_id: Number(r.cleaner_id), date: day(r.review_date), reviewer: r.reviewer, link: r.link, bonus_paid: !!r.bonus_paid }))),
      adjRows: adj.map((a) => ({ row_no: a.row_no, cleaner_name: a.cleaner_name, kind: a.kind, amount: Number(a.amount), date: day(a.on_date), customer: a.customer, details: a.details, submitted_by: a.submitted_by })),
      adjSync: adjSync[0] ? { synced_at: adjSync[0].synced_at ? new Date(adjSync[0].synced_at).toISOString() : null, rows: adjSync[0].row_count, error: adjSync[0].error } : null,
    };
  }

  // Pay rate on each visit, per cleaner (from the whole snapshot), cached per build.
  const rateCache = new Map();
  function ratesFor(s) {
    if (!rateCache.has(s.taken_at)) {
      rateCache.clear();
      const m = new Map();
      for (const v of s.visits) for (const t of v.teams) {
        if (!m.has(t.id)) m.set(t.id, []);
        m.get(t.id).push({ date: v.date, rate: t.rate });
      }
      const out = new Map();
      for (const [id, pts] of m) out.set(id, { history: rateHistory(pts), first: pts.reduce((a, p) => (!a || p.date < a ? p.date : a), null) });
      rateCache.set(s.taken_at, out);
    }
    return rateCache.get(s.taken_at);
  }

  // Start date: Launch27's provider created date when known, else their first visit in the
  // last 12 months ("at least" when that is near the start of what we have).
  function startOf(info, rates, s) {
    if (info?.created_at) return { date: localDate(info.created_at), known: true };
    const first = rates?.first || null;
    if (!first) return { date: null, known: false };
    return { date: first, known: first > addDays(s.from, 14) };
  }

  // The 13-week figures the verdict is built from.
  function raiseInput({ st, info, s, side, rates, ratedShare, today13, from13, to13, adj = null }) {
    const row = cleanerRow(st);
    const start = startOf(info, rates, s);
    const rel = withSheet(reliability({ drops: side.drops.get(st.id) || [], checks: { missing: st.missing, late: [] }, from: from13, to: today13 }), adj?.by.get(st.id), from13, today13, !!adj?.connected);
    return {
      today: today13,
      start_date: start.date,
      start_known: start.known,
      visits: st.visits,
      rated: st.rated,
      happy: row.happy,
      stars: info?.stars ?? null,
      stars_count: info?.ratings_count ?? null,
      rated_share: ratedShare,
      on_time: row.on_time,
      tracked: st.tracked,
      reliability: rel,
      residential: st.residential,
      early_share: row.finished_early,
      complaints: (side.complaints.get(st.id) || []).filter((c) => c.date >= from13 && c.date <= today13).length,
      keeps: row.keeps,
      clients_started: row.clients_started,
      hours_per_week: round1((row.onsite_hours || row.booked_hours) / (RAISE_THRESHOLDS.windowDays / 7)),
      restrictive: restrictiveTags(info?.tags || []),
      google_reviews: (side.reviews.get(st.id) || []).filter((r) => r.date >= from13 && r.date <= today13).length + sheetReviews(adj?.by.get(st.id), from13, today13).length,
      rate: rates?.history?.current ?? null,
      ladder: ladderOf(info?.tags || []),
      margin: row.margin,
      _to: to13,
    };
  }

  const ratedShareOf = (s, from, to) => pct(new Set(s.visits.filter((v) => v.date >= from && v.date <= to && v.rating).map((v) => v.id)).size, s.visits.filter((v) => v.date >= from && v.date <= to).length);

  // ---------- Cleaner reports (Leslie's) ----------
  async function cleaners(period = '13w', { admin = false, locations = null } = {}) {
    const s = await needScoped(locations);
    const { from, to, days } = periodRange(s.today, period);
    const stats = cleanerStats(s.visits, s.byCustomer, from, to, s.today);
    const { ov, util } = await plannerView(locations);
    const info = new Map((ov?.rows || []).map((r) => [r.id, r]));
    const rows = [];
    for (const st of stats.values()) {
      const i = info.get(st.id);
      const u = util.get(st.id);
      const row = cleanerRow(st, { name: i?.name });
      rows.push({
        ...row,
        earned: admin ? row.earned : undefined,
        status: i?.status || 'unknown', status_label: i?.status_label || 'Not in the active list', assignable: !!i?.assignable, area: i?.area || null, color: i?.color || '#94A3B8', is_new: !!i?.is_new, hours_type: i?.hours_type || null,
        hours_per_week: round1((row.onsite_hours || row.booked_hours) / (days / 7)),
        hours_filled: u && u.capacity ? pct(u.booked, u.capacity) : null,
        flags: flagsFor(st, u),
      });
    }
    rows.sort((a, b) => b.visits - a.visits);
    const all = rows.filter((r) => r.visits);
    const tot = (k) => all.reduce((a, r) => a + (r[k] || 0), 0);
    const sumStats = [...stats.values()];
    const tracked = sumStats.reduce((a, s2) => a + s2.tracked, 0);
    return {
      taken_at: s.taken_at, period, from, to, admin,
      team: {
        cleaners: all.length,
        median_visits: median(all.map((r) => r.visits)),
        max_visits: all.length ? Math.max(...all.map((r) => r.visits)) : 0,
        on_time: pct(sumStats.reduce((a, s2) => a + s2.onTime, 0), tracked),
        check_ins: tracked,
        happy: pct(sumStats.reduce((a, s2) => a + s2.happy, 0), sumStats.reduce((a, s2) => a + s2.rated, 0)),
        rated_share: pct(new Set(s.visits.filter((v) => v.date >= from && v.date <= to && v.rating).map((v) => v.id)).size, s.visits.filter((v) => v.date >= from && v.date <= to).length),
        revenue: tot('revenue'),
        earned: admin ? tot('earned') : undefined,
        flagged: rows.filter((r) => r.flags.length && r.assignable).length,
      },
      rows,
    };
  }

  async function cleaner(id, period = '13w', { admin = false, locations = null } = {}) {
    const s = await needScoped(locations);
    const cid = Number(id);
    const { from, to, days } = periodRange(s.today, period);
    const stats = cleanerStats(s.visits, s.byCustomer, from, to, s.today);
    const st = stats.get(cid);
    const { ov, util } = await plannerView(locations);
    const i = (ov?.rows || []).find((r) => r.id === cid);
    if (!st && !i) throw Object.assign(new Error('No report for this cleaner'), { status: 404 });
    const base = st || cleanerStats([], new Map(), from, to, s.today).get(cid) || { id: cid, name: i?.name, visits: 0, onsiteMin: 0, bookedMin: 0, tracked: 0, onTime: 0, lateMin: [], long: 0, enroute: 0, km: [], rated: 0, happy: 0, unhappy: 0, unhappyRecent: 0, revenue: 0, earned: 0, last40: [] };
    const row = cleanerRow(base, { name: i?.name });
    const u = util.get(cid);
    const lastRatings = s.visits.filter((v) => v.rating && v.teams.some((t) => t.id === cid)).sort((a, b) => b.at - a.at).slice(0, 8).map((v) => ({ date: v.date, customer: v.customer, r: v.rating.r, comment: v.rating.comment }));
    const firstSeen = s.visits.filter((v) => v.teams.some((t) => t.id === cid)).reduce((m, v) => (!m || v.date < m ? v.date : m), null);
    return {
      taken_at: s.taken_at, period, from, to, admin,
      cleaner: { id: cid, name: i?.name || row.name, status: i?.status || 'unknown', status_label: i?.status_label || 'Not in the active list', area: i?.area || null, color: i?.color || '#94A3B8', tags: i?.tags || [], hours_type: i?.hours_type || null, phone: i?.phone || null, weekly_hours: i?.weekly_hours ?? null, first_seen: firstSeen },
      stats: { ...row, earned: admin ? row.earned : undefined, hours_per_week: round1((row.onsite_hours || row.booked_hours) / (days / 7)), hours_filled: u && u.capacity ? pct(u.booked, u.capacity) : null, booked_next4: u ? round1(u.booked) : null, capacity_next4: u ? round1(u.capacity) : null, per_hour: admin && row.earned && row.onsite_hours ? round1(row.earned / row.onsite_hours) : undefined },
      flags: flagsFor(base, u),
      series: weeklySeries(s.visits, cid, from, to),
      clients: regularClients(cid, s.byCustomer, now()).slice(0, 25),
      lost: (base.lost || []).map((l) => ({ customer: l.customer, stopped: l.stopped, to: l.to != null ? (ov?.rows.find((r) => r.id === l.to)?.name || 'another cleaner') : null })),
      ratings: lastRatings,
      last40: [...(base.last40 || [])].reverse(),
    };
  }

  // ---------- pay adjustments sheet ----------
  // Copies the sheet's late cancels, no-shows, late arrivals and Google review bonuses into
  // pay_adjustments (replaced whole). Synthetic rows on dev/QA. Read-only on the sheet.
  async function syncAdjustments() {
    const sheet = config.paySheet || {};
    try {
      let rows;
      if (config.l27Mode === 'mock') rows = mockAdjustments();
      else if (!sheet.id) throw new Error('No sheet is set (PAY_ADJUSTMENTS_SHEET_ID), so late cancels, no-shows and Google reviews aren\'t connected');
      else if (!sheet.serviceAccount) throw new Error('No Google service account is set (GMAIL_SERVICE_ACCOUNT_JSON), so the pay adjustments sheet can\'t be read');
      else rows = parseAdjustmentRows(await createSheetReader({ serviceAccount: sheet.serviceAccount, fetchImpl, now }).values(sheet.id, sheet.range));
      await db.tx(async (q) => {
        await q.query('DELETE FROM pay_adjustments');
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200);
          const vals = [];
          const ph = chunk.map((r, k) => {
            vals.push(r.row_no, r.cleaner_name, r.kind, r.amount, r.on_date, r.customer, r.details, r.submitted_by, r.valid);
            return `(${Array.from({ length: 9 }, (_, j) => `$${k * 9 + j + 1}`).join(',')})`;
          });
          await q.query(`INSERT INTO pay_adjustments (row_no, cleaner_name, kind, amount, on_date, customer, details, submitted_by, valid) VALUES ${ph.join(',')}`, vals);
        }
        await q.query('INSERT INTO pay_adjustments_sync (id, synced_at, row_count, error) VALUES (1, now(), $1, NULL) ON CONFLICT (id) DO UPDATE SET synced_at = now(), row_count = EXCLUDED.row_count, error = NULL', [rows.length]);
      });
      log.info('pay adjustments synced', { rows: rows.length });
      return { rows: rows.length };
    } catch (err) {
      await db.query('INSERT INTO pay_adjustments_sync (id, error) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error', [String(err.message).slice(0, 500)]).catch(() => {});
      log.warn('pay adjustments sync failed', { error: err.message });
      throw err;
    }
  }

  // Dev/QA: a few made-up sheet rows per cleaner, from the names in the synthetic Launch27.
  function mockAdjustments() {
    const names = new Map();
    for (const v of snap?.visits || []) for (const t of v.teams) names.set(t.id, t.name);
    const t = today();
    const out = [];
    let row = 2;
    const add = (name, kind, daysAgo, amount, customer) => out.push({ row_no: row++, cleaner_name: name, kind, amount, on_date: addDays(t, -daysAgo), customer, details: null, submitted_by: 'Synthetic', valid: true });
    [...names.entries()].sort((a, b) => a[0] - b[0]).forEach(([, name], i) => {
      if (i % 3 === 0) add(name, 'google_review', 9 + i, 10, 'Sample Client');
      if (i % 5 === 0) add(name, 'google_review', 30 + i, 10, 'Another Client');
      if (i % 4 === 1) add(name, 'late_cancel', 12 + i, -30, 'Sample Client');
      if (i % 6 === 3) add(name, 'late_cancel', 40 + i, -30, 'Another Client');
      if (i % 7 === 5) add(name, 'no_show', 20 + i, -100, 'Sample Client');
      if (i % 5 === 2) add(name, 'late_arrival', 15 + i, -30, 'Sample Client');
    });
    return out;
  }

  // Sheet rows per cleaner (matched by name), and the names that matched nobody.
  function adjustmentsBy(side, cleaners) {
    const match = nameMatcher(cleaners);
    const by = new Map();
    const unmatched = new Map();
    for (const a of side.adjRows || []) {
      const id = match(a.cleaner_name);
      if (id == null) {
        unmatched.set(a.cleaner_name, (unmatched.get(a.cleaner_name) || 0) + 1);
        continue;
      }
      if (!by.has(id)) by.set(id, []);
      by.get(id).push(a);
    }
    return { by, unmatched: [...unmatched.entries()].map(([name, rows]) => ({ name, rows })).sort((a, b) => b.rows - a.rows), connected: !!side.adjSync?.synced_at };
  }

  // Adds the sheet's no-shows and late cancels to the app's own drop log (the same visit is
  // counted once). With the sheet connected, reliability is known for the whole period.
  function withSheet(rel, rows, from, to, connected) {
    if (!connected) return rel;
    const mine = (rows || []).filter((a) => a.date >= from && a.date <= to);
    const seen = new Set(rel.incidents.filter((i) => i.kind === 'no_show' || i.kind === 'last_minute').map((i) => `${i.kind}|${i.visit_date}`));
    const fresh = mine.filter((a) => (a.kind === 'no_show' && !seen.has(`no_show|${a.date}`)) || (a.kind === 'late_cancel' && !seen.has(`last_minute|${a.date}`)));
    const ns = fresh.filter((a) => a.kind === 'no_show').length;
    const lc = fresh.length - ns;
    const sheetIncidents = mine.filter((a) => a.kind === 'late_arrival' || fresh.includes(a)).map((a) => ({
      date: a.date, visit_date: a.date, customer: a.customer, kind: a.kind === 'late_cancel' ? 'last_minute' : a.kind === 'late_arrival' ? 'late_reported' : a.kind,
      label: a.kind === 'no_show' ? 'No-show' : a.kind === 'late_cancel' ? 'Late cancel' : 'Late arrival (reported)', reason: `Pay adjustments sheet${a.amount ? ` · $${Math.abs(a.amount)}` : ''}${a.submitted_by ? ` · ${a.submitted_by}` : ''}`, lead_hours: null, counted: a.kind !== 'late_arrival', note: null, id: null,
    }));
    return {
      ...rel,
      known: true, partial: false, covers_from: from,
      no_shows: (rel.no_shows || 0) + ns,
      last_minute: (rel.last_minute || 0) + lc,
      short_notice: rel.short_notice || 0, with_notice: rel.with_notice || 0, sick_days: rel.sick_days || 0, uncoded: rel.uncoded || 0,
      late_reported: mine.filter((a) => a.kind === 'late_arrival').length,
      issues: rel.issues + ns + lc,
      incidents: [...rel.incidents, ...sheetIncidents].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    };
  }

  const sheetReviews = (rows, from, to) => (rows || []).filter((a) => a.kind === 'google_review' && a.date >= from && a.date <= to).map((a) => ({ date: a.date, reviewer: a.customer || 'Client', amount: a.amount, submitted_by: a.submitted_by }));

  // What admins see about the sheet connection (the page says how to fix it).
  function adjustmentsInfo(side, adj, admin) {
    const sheet = config.paySheet || {};
    return {
      connected: adj.connected,
      synced_at: side.adjSync?.synced_at || null,
      rows: side.adjSync?.rows ?? null,
      error: admin ? side.adjSync?.error || null : undefined,
      share_with: admin ? sheet.serviceAccount?.client_email || null : undefined,
      sheet_url: admin && sheet.id ? `https://docs.google.com/spreadsheets/d/${sheet.id}` : undefined,
      unmatched: admin ? adj.unmatched.slice(0, 40) : undefined,
    };
  }

  // ---------- 2.0 helpers ----------
  // Churn: a recurring client of ours with nothing booked ahead (their schedule is cancelled).
  // No clean for CHURN.days (60) days = churned, on the day it reaches 60; under that = at risk.
  // Counted against their regular cleaner at their last clean. Homemaking and hospital-program
  // clients are placed by the partner, so they're left out. Needs the planner's upcoming visits;
  // without them, churn is unknown (null), never zero.
  async function churnFor(s, today) {
    let upcoming = null;
    try {
      const src = schedule?.utilizationSource ? await schedule.utilizationSource() : null;
      if (src) upcoming = new Set(src.visits.filter((v) => v.customer_id != null && v.date >= today).map((v) => String(v.customer_id)));
    } catch { /* planner not running: churn unknown */ }
    const byCleaner = new Map();
    // Every recurring client per regular cleaner (the base for churn %): cleaner -> last-clean dates.
    const book = new Map();
    if (!upcoming) return { known: false, byCleaner, book };
    for (const [cid, list] of s.byCustomer) {
      const last = list.at(-1);
      if (!last || last.kind === 'one' || list.length < 2) continue;
      if (last.partner_kind === 'homemaking' || last.partner_kind === 'program') continue;
      const cleaner = mainBefore(list, last.at + 1);
      if (cleaner == null) continue;
      if (!book.has(cleaner)) book.set(cleaner, []);
      book.get(cleaner).push(last.date);
      if (upcoming.has(String(cid))) continue;
      const gap = daysBetween(last.date, today);
      if (gap < CHURN.minGap) continue;
      const churned = gap >= CHURN.days;
      const withThem = list.filter((v) => v.teams.some((t) => t.id === cleaner));
      const recent = list.slice(-6);
      const share = recent.filter((v) => v.teams.some((t) => t.id === cleaner)).length / recent.length;
      // "Loyal": a long-standing client who was almost always with this one cleaner. When such a
      // client leaves us altogether, it's worth a call to find out why.
      const loyal = withThem.length >= CHURN.loyalCleans && share >= CHURN.loyalShare;
      const entry = { customer_id: cid, customer: last.customer, last_clean: last.date, last_cleaner: last.teams.map((t) => t.name), days_since: gap, freq: last.freq, cleans: withThem.length, total_cleans: list.length, share: Math.round(share * 100) / 100, together_since: withThem[0]?.date || null, loyal, status: churned ? 'churned' : 'at_risk', churned_on: churned ? addDays(last.date, CHURN.days) : null };
      if (!byCleaner.has(cleaner)) byCleaner.set(cleaner, []);
      byCleaner.get(cleaner).push(entry);
    }
    for (const l of byCleaner.values()) l.sort((a, b) => (a.last_clean < b.last_clean ? 1 : -1));
    return { known: true, byCleaner, book };
  }

  // Typical hours from the end of a clean to its rating, for ratings in [from, to].
  function feedbackHours(s, from, to) {
    const hours = s.visits.filter((v) => v.date >= from && v.date <= to && v.rating?.at).map((v) => (Date.parse(v.rating.at) - (v.at + v.duration * 60_000)) / 3_600_000).filter((h) => Number.isFinite(h) && h >= 0);
    return hours.length ? round1(median(hours)) : null;
  }

  const marginOf = (statsList) => {
    const rev = statsList.reduce((a, x) => a + x.marginRev, 0);
    const pay = statsList.reduce((a, x) => a + x.marginPay, 0);
    return rev ? { dollars: Math.round(rev - pay), share: Math.round(((rev - pay) / rev) * 1000) / 1000 } : null;
  };

  // 2.0's "Losing clients": recurring clients who churned in the period (not Leslie's keeps).
  const churnFlag = (x) => [
    ...(x.churned >= CHURN.flagAt ? [{ kind: 'losing', label: 'Losing clients', detail: `${x.churned} recurring client${x.churned === 1 ? '' : 's'} churned this period${x.at_risk ? `, ${x.at_risk} more at risk` : ''}` }] : []),
    ...(x.loyal_left >= CHURN.loyalFlagAt ? [{ kind: 'loyal_left', label: 'Loyal clients leaving', detail: `${x.loyal_left} long-standing clients who were almost always with them stopped booking. Worth a call to those clients` }] : []),
  ];

  // Re-cleans found in the Launch27 visits, per cleaner of the original clean (cached per build).
  const recleanCache = new Map();
  function recleansFor(s) {
    const k = `${s.taken_at}|${s.visits.length}`;
    if (!recleanCache.has(k)) {
      recleanCache.clear();
      recleanCache.set(k, findRecleans(s.byCustomer));
    }
    return recleanCache.get(k);
  }

  // Reliability score: the share of their visits with no reliability issue. Issues are no-shows,
  // late cancellations (< 24 h), short-notice drops (24–72 h) and visits with a missing check-in
  // or check-out. Drops are only known from the change log's start (Oct 31, 2026).
  function reliabilityScore(rel, visits) {
    const drops = (rel.no_shows || 0) + (rel.last_minute || 0) + (rel.short_notice || 0);
    const issues = drops + (rel.missing_checks || 0);
    const base = visits + drops;
    return {
      score: base ? Math.round((1 - issues / base) * 1000) / 1000 : null,
      issues,
      no_shows: rel.no_shows,
      late_cancels: rel.last_minute,
      short_notice: rel.short_notice,
      missing_checks: rel.missing_checks,
      drops_known: rel.no_shows != null,
    };
  }

  // The 2.0 columns for one cleaner, with the rows behind each number (drill-downs).
  function extras2({ st, row, rel, side, churn, from, today, admin, recleans, adj }) {
    const complaints = (side.complaints.get(st.id) || []).filter((c) => c.date >= from && c.date <= today);
    const lost = churn.known ? churn.byCleaner.get(st.id) || [] : null;
    const rc = (recleans.get(st.id) || []).filter((e) => e.date >= from && e.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1));
    const churnedNow = lost ? lost.filter((c) => c.status === 'churned' && c.churned_on >= from && c.churned_on <= today) : [];
    const atRisk = lost ? lost.filter((c) => c.status === 'at_risk') : [];
    // Churn %: churned clients ÷ the recurring clients they were the regular cleaner for in the
    // period (those with a clean in the period, plus those who churned in it).
    const recurring = lost ? (churn.book.get(st.id) || []).filter((d) => d >= from).length + churnedNow.filter((c) => c.last_clean < from).length : null;
    const fromSheet = sheetReviews(adj.by.get(st.id), from, today);
    const fromApp = (side.reviews.get(st.id) || []).filter((g) => g.date >= from && g.date <= today).map((g) => ({ date: g.date, reviewer: g.reviewer, amount: g.bonus_paid ? 10 : 0, submitted_by: null }));
    const reviews = [...fromSheet, ...fromApp].sort((a, b) => (a.date < b.date ? 1 : -1));
    const inc = (kind) => rel.incidents.filter((i) => i.kind === kind && i.counted).map((i) => ({ date: i.date, customer: i.customer, reason: i.reason }));
    return {
      reliability_score: reliabilityScore(rel, row.visits),
      reclean_rate: row.visits ? Math.round((rc.length / row.visits) * 1000) / 1000 : null,
      engagement: row.visits ? Math.round((row.rated / row.visits) * 1000) / 1000 : null,
      churned: lost ? churnedNow.length : null,
      recurring_clients: recurring,
      churn_rate: recurring ? Math.round((churnedNow.length / recurring) * 1000) / 1000 : null,
      at_risk: lost ? atRisk.length : null,
      loyal_left: churnedNow.filter((c) => c.loyal).length,
      moved: (st.lost || []).filter((l) => l.to != null).length,
      recleans: rc.length,
      complaints_n: complaints.length,
      google_reviews: reviews.length,
      review_bonus: reviews.reduce((a, g) => a + (g.amount > 0 ? g.amount : 0), 0),
      reliability2: rel.no_shows == null ? null : rel.no_shows + rel.last_minute,
      margin_dollars: admin && st.marginRev ? Math.round(st.marginRev - st.marginPay) : undefined,
      drill: {
        churn: [...churnedNow, ...atRisk],
        ratings: [...(st.ratedList || [])].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 150),
        recleans: rc,
        late_cancels: inc('last_minute'),
        no_shows: inc('no_show'),
        reviews,
      },
    };
  }

  // ---------- Cleaner reports 2.0 ----------
  // Leslie's report plus: engagement rate, churn, margin, re-cleans, reliability (last-minute
  // cancellations + no-shows), Google reviews, and the raise review. On 2.0 timing rules.
  async function cleaners2(period = '13w', { admin = false, locations = null } = {}) {
    const s = await needScoped(locations);
    const { from, to, days } = periodRange(s.today, period);
    const stats = cleanerStats(s.visits, s.byCustomer, from, to, s.today, V2);
    const today = localDate(now());
    const side = await sideData(from);
    const team = teamLong(stats);
    const { ov, util } = await plannerView(locations);
    const info = new Map((ov?.rows || []).map((r) => [r.id, r]));
    const churn = await churnFor(s, today);
    const recleans = recleansFor(s);
    const adj = adjustmentsBy(side, [...new Map([...[...stats.values()].map((x) => [x.id, x.name]), ...(ov?.rows || []).map((x) => [x.id, x.name])]).entries()].map(([id, name]) => ({ id, name })));
    const rows = [];
    for (const st of stats.values()) {
      const i = info.get(st.id);
      const u = util.get(st.id);
      const row = cleanerRow(st, { name: i?.name });
      const rel = withSheet(reliability({ drops: side.drops.get(st.id) || [], checks: { missing: st.missing, late: [] }, from, to: today }), adj.by.get(st.id), from, today, adj.connected);
      const extra = extras2({ st, row, rel, side, churn, from, today, admin, recleans, adj });
      rows.push({
        ...extra,
        ...row,
        earned: admin ? row.earned : undefined,
        margin: admin ? row.margin : undefined,
        status: i?.status || 'unknown', status_label: i?.status_label || 'Not in the active list', assignable: !!i?.assignable, area: i?.area || null, color: i?.color || '#94A3B8', is_new: !!i?.is_new, hours_type: i?.hours_type || null,
        hours_per_week: round1((row.onsite_hours || row.booked_hours) / (days / 7)),
        hours_filled: u && u.capacity ? pct(u.booked, u.capacity) : null,
        stars: i?.stars ?? null, ratings_count: i?.ratings_count ?? null,
        reliability: { issues: rel.issues, no_shows: rel.no_shows, last_minute: rel.last_minute, short_notice: rel.short_notice, missing_checks: rel.missing_checks, partial: rel.partial, covers_from: rel.covers_from, uncoded: rel.uncoded },
        flags: [...flagsFor(st, u, team, V2), ...churnFlag(extra)],
      });
    }
    rows.sort((a, b) => b.visits - a.visits);
    const all = rows.filter((r) => r.visits);
    const tot = (k) => all.reduce((a, r) => a + (r[k] || 0), 0);
    const sumStats = [...stats.values()];
    const tracked = sumStats.reduce((a, s2) => a + s2.tracked, 0);
    return {
      taken_at: s.taken_at, period, from, to, admin,
      change_log_start: CHANGE_LOG_START,
      team: {
        cleaners: all.length,
        median_visits: median(all.map((r) => r.visits)),
        max_visits: all.length ? Math.max(...all.map((r) => r.visits)) : 0,
        on_time: pct(sumStats.reduce((a, s2) => a + s2.onTime, 0), tracked),
        check_ins: tracked,
        happy: pct(sumStats.reduce((a, s2) => a + s2.happy, 0), sumStats.reduce((a, s2) => a + s2.rated, 0)),
        rated_share: ratedShareOf(s, from, to),
        revenue: tot('revenue'),
        earned: admin ? tot('earned') : undefined,
        flagged: rows.filter((r) => r.flags.length && r.assignable).length,
        runs_long_median: team.median,
        // Engagement: share of visits that got a rating, and how fast ratings come in.
        engagement: ratedShareOf(s, from, to),
        feedback_hours: feedbackHours(s, from, to),
        margin: admin ? marginOf(sumStats) : undefined,
        churned: churn.known ? rows.reduce((a, r) => a + (r.churned || 0), 0) : null,
        recurring_clients: churn.known ? rows.reduce((a, r) => a + (r.recurring_clients || 0), 0) : null,
        churn_rate: churn.known ? pct(rows.reduce((a, r) => a + (r.churned || 0), 0), rows.reduce((a, r) => a + (r.recurring_clients || 0), 0)) : null,
        at_risk: churn.known ? rows.reduce((a, r) => a + (r.at_risk || 0), 0) : null,
      },
      churn_known: churn.known,
      churn_days: CHURN.days,
      adjustments: adjustmentsInfo(side, adj, admin),
      rows,
    };
  }

  async function cleaner2(id, period = '13w', { admin = false, locations = null } = {}) {
    const s = await needScoped(locations);
    const cid = Number(id);
    const { from, to, days } = periodRange(s.today, period);
    const stats = cleanerStats(s.visits, s.byCustomer, from, to, s.today, V2);
    const st = stats.get(cid);
    const { ov, util } = await plannerView(locations);
    const i = (ov?.rows || []).find((r) => r.id === cid);
    if (!st && !i) throw Object.assign(new Error('No report for this cleaner'), { status: 404 });
    const base = st || emptyStats(cid, i?.name);
    const row = cleanerRow(base, { name: i?.name });
    const u = util.get(cid);
    const today = localDate(now());
    const r13 = periodRange(s.today, '13w');
    const stats13 = period === '13w' ? stats : cleanerStats(s.visits, s.byCustomer, r13.from, r13.to, s.today, V2);
    const side = await sideData(from < r13.from ? from : r13.from);
    const rates = ratesFor(s).get(cid);
    const team = teamLong(stats);
    const start = startOf(i, rates, s);
    const lastRatings = s.visits.filter((v) => v.rating && v.teams.some((t) => t.id === cid)).sort((a, b) => b.at - a.at).slice(0, 8).map((v) => ({ date: v.date, customer: v.customer, r: v.rating.r, comment: v.rating.comment }));
    const firstSeen = rates?.first || null;
    const adj = adjustmentsBy(side, [...new Map([...[...stats.values()].map((x) => [x.id, x.name]), ...(ov?.rows || []).map((x) => [x.id, x.name])]).entries()].map(([k, name]) => ({ id: k, name })));
    const rel = withSheet(reliability({ drops: side.drops.get(cid) || [], checks: { missing: base.missing, late: base.lateList }, from, to: today }), adj.by.get(cid), from, today, adj.connected);
    const churn = await churnFor(s, today);
    const recleans = recleansFor(s);
    const extra = extras2({ st: base, row, rel, side, churn, from, today, admin, recleans, adj });
    let raise;
    if (admin) {
      const st13 = stats13.get(cid) || emptyStats(cid, i?.name);
      const input = raiseInput({ st: st13, info: i, s, side, rates, ratedShare: ratedShareOf(s, r13.from, r13.to), today13: today, from13: r13.from, to13: r13.to, adj });
      const review = raiseReview(input);
      const name = i?.name || row.name;
      raise = {
        ...review,
        from: r13.from,
        to: today,
        rate: rates?.history || null,
        margin: input.margin,
        summary: slackSummary({ name, review, rate: rates?.history || null, from: r13.from, to: today }),
      };
    }
    return {
      taken_at: s.taken_at, period, from, to, admin,
      change_log_start: CHANGE_LOG_START,
      cleaner: { id: cid, name: i?.name || row.name, status: i?.status || 'unknown', status_label: i?.status_label || 'Not in the active list', area: i?.area || null, color: i?.color || '#94A3B8', tags: i?.tags || [], hours_type: i?.hours_type || null, phone: i?.phone || null, weekly_hours: i?.weekly_hours ?? null, first_seen: firstSeen, start_date: start.date, start_known: start.known, stars: i?.stars ?? null, ratings_count: i?.ratings_count ?? null, restrictive: restrictiveTags(i?.tags || []) },
      stats: { ...row, ...extra, earned: admin ? row.earned : undefined, margin: admin ? row.margin : undefined, hours_per_week: round1((row.onsite_hours || row.booked_hours) / (days / 7)), hours_filled: u && u.capacity ? pct(u.booked, u.capacity) : null, booked_next4: u ? round1(u.booked) : null, capacity_next4: u ? round1(u.capacity) : null, per_hour: admin && row.earned && row.onsite_hours ? round1(row.earned / row.onsite_hours) : undefined },
      flags: [...flagsFor(base, u, team, V2), ...churnFlag(extra)],
      team: { runs_long_median: team.median },
      series: weeklySeries(s.visits, cid, from, to, V2),
      clients: regularClients(cid, s.byCustomer, now()).slice(0, 25),
      lost: (base.lost || []).map((l) => ({ customer: l.customer, stopped: l.stopped, to: l.to != null ? (ov?.rows.find((r) => r.id === l.to)?.name || 'another cleaner') : null })),
      ratings: lastRatings,
      last40: [...(base.last40 || [])].reverse(),
      reliability: { ...rel, weeks: reliabilityWeeks(rel, from, today, adj.connected ? '2000-01-01' : undefined) },
      sheet_reviews: sheetReviews(adj.by.get(cid), from, today),
      adjustments: adjustmentsInfo(side, adj, admin),
      finished_early: [...base.earlyList].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30),
      complaints: (side.complaints.get(cid) || []).filter((c) => c.date >= from),
      google_reviews: side.reviews.get(cid) || [],
      recleans: (recleans.get(cid) || []).filter((e) => e.date >= from && e.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1)),
      churn: { known: churn.known, days: CHURN.days, clients: churn.known ? (churn.byCleaner.get(cid) || []).filter((c) => c.status === 'at_risk' || c.churned_on >= from) : [] },
      raise,
    };
  }

  // ---------- monthly raise check ----------
  // Once a month (the first build of the month, after 8 am Toronto), each admin (or just the
  // people in RAISE_DIGEST_EMAILS) gets a private bell notification for every cleaner taking
  // bookings who looks ready for a raise review. Nothing is shown to the team, nothing is sent
  // when nobody is ready, and cleaners raised in the last 90 days are left out.
  let digestDone = null; // the month already handled, so later ticks skip the database
  async function raiseCheckCandidates(today) {
    const s = await need();
    const r13 = periodRange(s.today, '13w');
    const stats13 = cleanerStats(s.visits, s.byCustomer, r13.from, r13.to, s.today, V2);
    const side = await sideData(r13.from);
    const rates = ratesFor(s);
    const ratedShare = ratedShareOf(s, r13.from, r13.to);
    const { ov } = await plannerView(null);
    const info = new Map((ov?.rows || []).map((r) => [r.id, r]));
    const adj = adjustmentsBy(side, (ov?.rows || []).map((r) => ({ id: r.id, name: r.name })));
    const out = [];
    for (const st of stats13.values()) {
      const i = info.get(st.id);
      if (!i?.assignable) continue;
      const rt = rates.get(st.id);
      const review = raiseReview(raiseInput({ st, info: i, s, side, rates: rt, ratedShare, today13: today, from13: r13.from, to13: r13.to, adj }));
      if (review.underlying !== 'ready' || review.verdict === 'thin' || review.verdict === 'ceiling') continue;
      if (review.verdict === 'ladder' && !review.ladder?.next) continue;
      if (rt?.history?.changed_on && daysBetween(rt.history.changed_on, today) < 90) continue;
      out.push({ id: st.id, name: i.name, next_step: review.verdict === 'ladder' ? review.ladder.next : null });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function raiseDigest({ force = false } = {}) {
    const today = localDate(now());
    const month = today.slice(0, 7);
    if (digestDone === month && !force) return null;
    const s = await load();
    if (!s) return null;
    if (!force && (s.today < today || Number(HOUR.format(new Date(now()))) < 8)) return null;
    if (!force && (await db.query('SELECT 1 FROM raise_digests WHERE month = $1', [month])).rows.length) {
      digestDone = month;
      return null;
    }
    const cleaners = await raiseCheckCandidates(today);
    const only = String(config.raiseDigestEmails || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    const admins = (await db.query("SELECT id, lower(email) AS email FROM users WHERE role = 'admin' AND active")).rows.filter((u) => !only.length || only.includes(u.email));
    const sent = await db.tx(async (q) => {
      const claimed = await q.query("INSERT INTO raise_digests (month, cleaners, recipients) VALUES ($1, $2::jsonb, $3) ON CONFLICT (month) DO UPDATE SET sent_at = now(), cleaners = EXCLUDED.cleaners, recipients = EXCLUDED.recipients WHERE $4::boolean RETURNING month", [month, JSON.stringify(cleaners), admins.length, force]);
      if (!claimed.rows.length) return 0;
      let n = 0;
      for (const c of cleaners) {
        const text = c.next_step ? `Raise check: ${c.name} looks ready for ${c.next_step}` : `Raise check: ${c.name} looks ready for a raise review`;
        for (const u of admins) {
          await q.query("INSERT INTO notifications (user_id, kind, conversation_id, text, link) VALUES ($1, 'raise_check', NULL, $2, $3)", [u.id, text, `/reports/cleaners-2/${c.id}#raise`]);
          n++;
        }
      }
      return n;
    });
    digestDone = month;
    log.info('monthly raise check', { month, cleaners: cleaners.length, notifications: sent });
    return { month, cleaners, notifications: sent };
  }

  // ---------- drops: record and code ----------
  // Dispatch removes a cleaner (reason picked there), or someone codes a drop the sync found.
  async function recordDrop({ cleaner_id, visit_key, booking_id = null, customer = null, visit_at, reason }, userId) {
    if (!DROP_REASONS[reason]) throw Object.assign(new Error('Pick a reason'), { status: 400 });
    const cid = Number(cleaner_id);
    const key = String(visit_key || booking_id || '');
    if (!cid || !key) throw Object.assign(new Error('cleaner_id and visit_key are required'), { status: 400 });
    const at = Date.parse(visit_at);
    if (!Number.isFinite(at)) throw Object.assign(new Error('visit_at must be a date and time'), { status: 400 });
    const row = (await db.query(
      `INSERT INTO cleaner_drops (cleaner_id, visit_key, booking_id, customer, visit_at, dropped_at, reason, source, coded_by, coded_at) VALUES ($1,$2,$3,$4,$5,now(),$6,'dispatch',$7,now())
       ON CONFLICT (visit_key, cleaner_id) DO UPDATE SET reason = EXCLUDED.reason, coded_by = EXCLUDED.coded_by, coded_at = now() RETURNING id`,
      [cid, key, booking_id ? Number(booking_id) : null, customer ? String(customer).slice(0, 200) : null, new Date(at).toISOString(), reason, userId || null],
    )).rows[0];
    return { id: Number(row.id) };
  }

  // Code the drops behind one "Cleaner changed" card.
  async function codeChange(changeId, reason, userId) {
    if (!DROP_REASONS[reason]) throw Object.assign(new Error('Pick a reason'), { status: 400 });
    const res = await db.query('UPDATE cleaner_drops SET reason = $2, coded_by = $3, coded_at = now() WHERE change_id = $1 RETURNING id', [Number(changeId), reason, userId || null]);
    return { coded: res.rows.length };
  }
  async function dropsForChanges(ids) {
    if (!ids.length) return new Map();
    const rows = (await db.query('SELECT change_id, cleaner_id, reason FROM cleaner_drops WHERE change_id = ANY($1::bigint[])', [ids.map(Number)])).rows;
    const m = new Map();
    for (const r of rows) {
      const k = Number(r.change_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ cleaner_id: Number(r.cleaner_id), reason: r.reason });
    }
    return m;
  }

  // ---------- Google reviews (phase 1: typed in) ----------
  async function addReview(cleanerId, { review_date, reviewer, link = null, bonus_paid = false }, userId) {
    const d = String(review_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw Object.assign(new Error('Review date is required'), { status: 400 });
    if (!String(reviewer || '').trim()) throw Object.assign(new Error('Reviewer is required'), { status: 400 });
    if (link && !/^https?:\/\//i.test(String(link))) throw Object.assign(new Error('Link must start with http'), { status: 400 });
    const row = (await db.query('INSERT INTO cleaner_google_reviews (cleaner_id, review_date, reviewer, link, bonus_paid, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [Number(cleanerId), d, String(reviewer).trim().slice(0, 200), link ? String(link).slice(0, 1000) : null, !!bonus_paid, userId || null])).rows[0];
    return { id: Number(row.id) };
  }
  async function updateReview(id, { bonus_paid }) {
    await db.query('UPDATE cleaner_google_reviews SET bonus_paid = $2 WHERE id = $1', [Number(id), !!bonus_paid]);
  }
  async function deleteReview(id) {
    await db.query('DELETE FROM cleaner_google_reviews WHERE id = $1', [Number(id)]);
  }

  async function status() {
    const s = await load();
    const last = (await db.query('SELECT status, error, taken_at FROM report_snapshots ORDER BY id DESC LIMIT 1')).rows[0];
    // auto_build: whether the overnight build can run here (it needs a Launch27 sync login in
    // production). Without it, only an admin's "Build now" builds the reports.
    const auto_build = config.l27Mode === 'mock' || !!(config.l27SyncEmail && config.l27SyncPassword);
    return { taken_at: s?.taken_at || null, built_for: s?.today || null, running: !!running, last_error: last?.status === 'failed' ? last.error : null, covers_from: s?.from || null, auto_build };
  }

  // Utilization (read-only): of cleaners' open hours from..to, how much is spoken for and how
  // much is left to book. Built from the planner's live copy (8 weeks ahead).
  async function utilization({ from, to, locations = null, mode = 'all' } = {}) {
    mode = mode === 'residential' ? 'residential' : 'all';
    if (!schedule?.utilizationSource) throw Object.assign(new Error('The scheduling planner is not running'), { status: 409 });
    let src;
    try {
      src = await schedule.utilizationSource();
    } catch (err) {
      throw Object.assign(new Error(err.message), { status: err.status || 409 });
    }
    const maxTo = addDays(src.today, 55);
    // Past weeks: back to what the planner keeps (13 weeks), or further where the daily record
    // has the day (hours as they were then).
    const liveFrom = src.history_from && src.history_from < src.today ? src.history_from : src.today;
    const firstRecorded = schedule.firstRecordedDay ? await schedule.firstRecordedDay().catch(() => null) : null;
    const minFrom = firstRecorded && firstRecorded < liveFrom ? firstRecorded : liveFrom;
    const range = clampRange(src.today, from, to, maxTo, minFrom);
    const start = range.from < src.today ? (range.from < liveFrom ? liveFrom : range.from) : src.today;
    const live = utilizationFacts({ today: src.today, start, cleaners: src.cleaners, visits: src.visits, holidays: src.holidays, unavailable: src.unavailable, excluded: src.excluded || new Map(), locations, mode });
    // Saved days in the chosen dates (before today; today and later are always live).
    const yesterday = addDays(src.today, -1);
    const saved = range.from <= yesterday && schedule.recordedDays ? await schedule.recordedDays(range.from, range.to < yesterday ? range.to : yesterday).catch(() => []) : [];
    const recorded = saved.map((r) => ({
      ...utilizationFacts({ today: src.today, start: r.day, until: r.day, cleaners: r.cleaners || [], visits: r.visits || [], holidays: r.holidays || [], unavailable: new Map((r.unavailable || []).map((id) => [Number(id), new Set([r.day])])), excluded: new Map((r.excluded || []).map((id) => [Number(id), new Set([r.day])])), locations, mode }),
      recorded_days: [r.day],
    }));
    const facts = withRecordedDays(live, recorded);
    // Scheduling insights' own figures, for "Check the numbers".
    const { ov } = await plannerView(locations);
    let existing = null;
    if (ov) {
      const rows = ov.rows.filter((r) => r.assignable);
      const w4 = (k) => rows.reduce((m, r) => m + r.weeks.slice(0, 4).reduce((a, x) => a + x[k], 0), 0);
      existing = { capacity4: w4('capacity'), booked4: w4('booked'), unassigned_visits: ov.counts.unassigned_visits, tolerance: Math.max(0.5, rows.length * 4 * 0.05) };
    }
    const report = utilizationReport({ facts, ...range, maxTo, minFrom, cfg: UTILIZATION, existing, takenAt: src.taken_at, cleaners: src.cleaners, source: { full_at: src.full_at, cleaners_by: src.cleaners_by } });
    // Recommended cleaners for the bookings with no cleaner yet (upcoming ones; the planner's ranking).
    const keys = report.needs_cleaner.filter((x) => x.kind === 'unassigned' && x.date >= src.today).slice(0, 150).map((x) => x.key);
    const recs = keys.length && schedule.recommendFor ? await schedule.recommendFor(keys, 3).catch(() => ({})) : {};
    for (const x of report.needs_cleaner) x.recommended = recs[x.key] || [];
    // Where past days come from: the daily record (hours as they were) or rebuilt (current hours).
    const pastTo = range.to < yesterday ? range.to : yesterday;
    let pastDays = 0;
    for (let d = range.from; d <= pastTo; d = addDays(d, 1)) if (new Date(`${d}T12:00:00Z`).getUTCDay() !== 0) pastDays++;
    report.history = { first_recorded: firstRecorded, recorded_days: (facts.recorded_days || []).filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() !== 0).length, past_days: pastDays };
    return report;
  }

  // The raw year of visits (for the Commercial area).
  const visitsSnapshot = () => need();
  // Daily field-operations counts and the next four weeks' hours by area, for the analytics feed.
  async function fieldFeed({ from = null, to = null } = {}) {
    const s = await need();
    const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const end = day(to) || addDays(s.today, -1);
    const start = day(from) || addDays(end, -364);
    const { ov, util } = await plannerView(null);
    const area = new Map((ov?.rows || []).map((r) => [r.id, r.area || 'Unknown']));
    const areas = new Map();
    for (const [, u] of util) {
      if (!u.row.assignable) continue;
      const a = areas.get(u.row.area) || { area: u.row.area || 'Unknown', cleaners: 0, booked: 0, capacity: 0 };
      a.cleaners += 1; a.booked += u.booked; a.capacity += u.capacity;
      areas.set(a.area, a);
    }
    return {
      taken_at: s.taken_at, from: start, to: end, columns: FIELD_COLUMNS, rows: fieldDaily(s.visits, s.byCustomer, start, end, area),
      capacity_columns: ['area', 'assignable_cleaners', 'booked_hours_per_week', 'capacity_hours_per_week', 'unassigned_visits'],
      capacity: [...areas.values()].map((a) => [a.area, a.cleaners, round1(a.booked / 2), round1(a.capacity / 2), null]).concat([['All areas', [...areas.values()].reduce((x, a) => x + a.cleaners, 0), null, null, ov?.counts?.unassigned_visits ?? null]]),
      planner: await plannerHealth('4w'),
    };
  }
  return { fieldFeed, sync, start, maybeRun, scheduling, utilization, cleaners, cleaner, cleaners2, cleaner2, status, visitsSnapshot, syncAdjustments, recordDrop, codeChange, dropsForChanges, raiseDigest, raiseCheckCandidates, addReview, updateReview, deleteReview, isRunning: () => !!running, mondayOf };
}
