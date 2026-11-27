// Utilization: of the hours cleaners have open, how much is already spoken for, and how much is
// left to book.
//
//   Available   = cleaners' open hours in Launch27 (taking bookings), Monday–Saturday
//   Committed   = assigned + commercial + unassigned (+ work on cleaners not taking bookings) + travel
//   Left        = available − committed
//   Utilization = committed ÷ available
//
// Two views while residential and commercial are being split (mode):
//   'all' (default) — all work: a shared cleaner's full Launch27 hours count, and their commercial
//                      bookings (and the drives to them) are committed time, shown as "Commercial".
//   'residential'   — residential only: time booked for commercial comes off the cleaner's hours.
//
// Pure calculation over the planner's saved copy of Launch27 (no fetching, no writes).
// Available hours = each cleaner's hours in Launch27 (weekly hours, or that date's own hours
// when set; every block of a split day), minus days off set in Launch27 or marked unavailable in
// this app, minus dates they are excluded from booking in Launch27 (Daily spots), minus company
// closed dates (unless the cleaner has their own hours set for that date).
// Every booking counts its full scheduled Duration from Launch27 for each cleaner on it, never the
// time on site and never trimmed to the cleaner's hours (time past their hours is shown in Data
// check as "over availability").
import { addDays, areaOf, capacityMinutes, km, mondayOf, toMinutes, travelMinutes, weekday, workingBlocks, workingMinutes, workingWindow } from '../schedule/rules.js';
import { UTILIZATION } from './utilization-config.js';

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const ratio = (a, b) => (b > 0 ? a / b : null);

// ---------- intervals (minutes since midnight) ----------
function merge(list) {
  const s = list.filter(([a, b]) => b > a).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const clip = (list, [w0, w1]) => list.map(([a, b]) => [Math.max(a, w0), Math.min(b, w1)]).filter(([a, b]) => b > a);
// The parts of a list of intervals that fall inside any of the blocks.
const within = (list, blocks) => blocks.flatMap((b) => clip(list, b));
const total = (list) => merge(list).reduce((m, [a, b]) => m + (b - a), 0);
// Lengths (minutes) of the open stretches of a window once the blocks are taken out.
export function openStretches(window, blocks) {
  const out = [];
  let t = window[0];
  for (const [a, b] of merge(clip(blocks, window))) {
    if (a > t) out.push(a - t);
    t = Math.max(t, b);
  }
  if (window[1] > t) out.push(window[1] - t);
  return out;
}
// A booking's scheduled time: its start plus its full Duration in Launch27.
const span = (v) => [v.start, v.start + (Number(v.duration) || 0)];

// Partner work (Carefor, OWCS, hospital programs, other homemaking) is commercial work.
export const isPartnerWork = (v) => v.partner_kind === 'program' || v.partner_kind === 'homemaking' || /carefor|owcs|homemaking/i.test(`${v.partner_name || ''} ${v.account_name || ''}`);

/**
 * The per-day facts every figure is summed from.
 * input: { today, cleaners, visits, holidays, unavailable: Map(id -> Set(dates)), excluded: Map(id -> Set(dates)), locations, mode, cfg, until }
 *   cleaners: planner cleaners ({ id, name, area, assignable, location_ids, availability, lat, lng, rules })
 *   visits:   planner visits ({ key, date, start, end, duration, team_ids, location_id, customer_id, kind, lat, lng })
 *   holidays: company closed dates ({ date, start_time, end_time, location_id })
 *   excluded: dates a cleaner is excluded from booking in Launch27's Daily spots
 *   locations: the residential location ids (other locations' bookings are commercial); null = no split
 */
export function utilizationFacts({ today, start = today, cleaners, visits, holidays = [], unavailable = new Map(), excluded = new Map(), locations = null, mode = 'all', cfg = UTILIZATION, until }) {
  const all = mode !== 'residential';
  const brandIds = Array.isArray(locations) && locations.length ? new Set(locations.map(Number)) : null;
  const inBrand = (v) => !brandIds || brandIds.has(Number(v.location_id));
  const cleanerInBrand = (c) => !brandIds || !c.location_ids?.length || c.location_ids.some((id) => brandIds.has(Number(id)));
  const operating = new Set(cfg.operatingDays);
  // One leg of travel, in minutes (the planner's model; fallback when a pin is missing).
  const leg = (a, b, transit) => {
    const d = km(a, b);
    return d == null ? cfg.travelFallbackMinutes : travelMinutes(d, transit);
  };
  const legs = [];
  // Through the weekly chart's last week, or the last visit in the copy if later (so every
  // unassigned visit the planner counts is accounted for in the reconciliation).
  const lastVisit = visits.reduce((m, v) => (v.date > m ? v.date : m), today);
  const trendEnd = addDays(mondayOf(today), cfg.trendWeeks * 7 - 1);
  const end = until || (lastVisit > trendEnd ? lastVisit : trendEnd);

  const future = visits.filter((v) => v.date >= start && v.date <= end);
  const byId = new Map(cleaners.map((c) => [c.id, c]));
  // The cleaners whose availability counts: taking bookings, in the viewed locations, plus anyone
  // taking bookings who has residential bookings in these dates though their own locations are
  // all commercial (so their residential work is neither dropped nor counted twice).
  const withBrandWork = new Set(future.filter(inBrand).flatMap((v) => v.team_ids));
  const taking = cleaners.filter((c) => c.assignable && (cleanerInBrand(c) || withBrandWork.has(c.id)));
  const takingIds = new Set(taking.map((c) => c.id));

  const busy = new Map(); // `${id}|${date}` -> visits
  for (const v of future) for (const id of v.team_ids) {
    const k = `${id}|${v.date}`;
    if (!busy.has(k)) busy.set(k, []);
    busy.get(k).push(v);
  }
  // Each cleaner on a booking is there for its whole scheduled Duration.
  const hours = (v) => Number(v.duration) || 0;
  const closedFor = (c, d) => holidays
    .filter((h) => String(h.date).slice(0, 10) === d && (h.location_id == null || !c.location_ids?.length || c.location_ids.map(Number).includes(Number(h.location_id))))
    .map((h) => [h.start_time ? toMinutes(h.start_time) : 0, h.end_time ? toMinutes(h.end_time) : 24 * 60])
    .map(([a, b]) => (b > a ? [a, b] : [0, 24 * 60]));
  const ownHoursOn = (c, d) => (c.availability || []).some((r) => r.date && String(r.date).slice(0, 10) === d && !r.dayoff && r.start_time && r.end_time);

  const days = []; // one per taking cleaner per date
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const sunday = !operating.has(weekday(d));
    for (const c of taking) {
      const un = unavailable.get(c.id);
      const w = workingWindow(c.availability, d, un);
      const allBlocks = workingBlocks(c.availability, d, un);
      const out = !!excluded.get(c.id)?.has(d); // excluded from booking that day in Launch27
      const blocks = out ? [] : allBlocks;
      const blocksMin = total(allBlocks);
      const excludedMin = out ? blocksMin : 0;
      const base = blocksMin - excludedMin;
      const list = busy.get(`${c.id}|${d}`) || [];
      const mine = list.filter(inBrand);
      const other = list.filter((v) => !inBrand(v));
      // Company closed date: not available, unless this cleaner has their own hours set that day.
      const closed = blocks.length && !ownHoursOn(c, d) ? merge(within(closedFor(c, d), blocks)) : [];
      const closedMin = total(closed);
      // Residential only: time booked for commercial comes off the cleaner's hours.
      const otherMin = all ? 0 : total([...closed, ...within(other.map(span), blocks)]) - closedMin;
      const avail = Math.max(base - closedMin - otherMin, 0);
      const assigned = mine.reduce((m, v) => m + hours(v), 0);
      const commercial = other.reduce((m, v) => m + hours(v), 0);
      // Committed work that runs past the cleaner's open hours (or on a day they have none).
      const counted = all ? list : mine;
      const open = closed.length ? blocks.flatMap((b) => openSpans(b, closed)) : blocks;
      const over = counted.reduce((m, v) => m + hours(v) - total(within([span(v)], open)), 0);
      // Travel along the day's route: home → each visit in time order → home. In residential
      // only, commercial visits are stops on the route but only legs into residential visits
      // (and the drive home after one) count.
      const transit = !!c.rules?.transit;
      const home = { lat: c.lat, lng: c.lng };
      const route = [...list].sort((a, b) => a.start - b.start);
      let travel = 0;
      let at = home;
      const busyBlocks = []; // every visit plus the drive to it, for the open gaps
      for (const v of route) {
        const m = leg(at, v, transit);
        if (all || inBrand(v)) travel += m;
        legs.push(m);
        busyBlocks.push([v.start - m, span(v)[1]]);
        at = v;
      }
      const last = route[route.length - 1];
      if (last && cfg.travelReturnHome) {
        const m = leg(last, home, transit);
        if (all || inBrand(last)) travel += m;
        busyBlocks.push([span(last)[1], span(last)[1] + m]);
      }
      // Open stretches of each block of the day once every visit (residential and commercial),
      // its drive and closed hours are taken out: "Room for" counts the bookings that fit these.
      const gaps = blocks.flatMap((b) => openStretches(b, [...closed, ...busyBlocks]));
      days.push({
        d, sunday, cid: c.id, area: c.area || 'Unknown', extra: !cleanerInBrand(c),
        window: capacityMinutes(w), base, excluded: excludedMin, closed: closedMin, other: otherMin, avail,
        assigned, commercial, travel, over, visits: mine.length, commercial_visits: other.length, gaps,
      });
    }
  }

  // Visits not on a taking cleaner: unassigned, or on a cleaner not taking bookings (on hold, etc.).
  const loose = [];
  const customers = [];
  const partnerChecks = [];
  for (const v of future) {
    const sunday = !operating.has(weekday(v.date));
    const brand = inBrand(v);
    const addrArea = areaOf({ lat: v.lat, lng: v.lng });
    if (brand && v.customer_id != null) customers.push({ d: v.date, sunday, customer: v.customer_id, recurring: v.kind !== 'one', area: addrArea });
    // Partner work filed under a residential location: probably commercial filed in the wrong place.
    if (brandIds && brand && isPartnerWork(v)) partnerChecks.push({ d: v.date, sunday, v });
    if (!v.team_ids.length) {
      loose.push({ kind: 'unassigned', d: v.date, sunday, brand, area: addrArea, hours: hours(v), travel: 0, key: v.key, v });
      continue;
    }
    if (!brand) continue;
    for (const id of v.team_ids) {
      if (takingIds.has(id)) continue;
      const c = byId.get(id);
      loose.push({ kind: 'not_taking', d: v.date, sunday, brand, area: c?.area || addrArea, hours: hours(v), travel: 0, cid: id, key: v.key, v, cleaner: c?.name || null });
    }
  }
  // Visits not on a taking cleaner have no route of their own: one average leg each.
  const avgLeg = legs.length ? legs.reduce((a, b) => a + b, 0) / legs.length : cfg.travelFallbackMinutes;
  for (const x of loose) x.travel = avgLeg;
  return { days, loose, customers, partner_checks: partnerChecks, taking, today, end, avg_leg_min: avgLeg, mode: all ? 'all' : 'residential', split: !!brandIds };
}
// A block with closed hours taken out.
function openSpans(block, closed) {
  const out = [];
  let t = block[0];
  for (const [a, b] of merge(clip(closed, block))) {
    if (a > t) out.push([t, a]);
    t = Math.max(t, b);
  }
  if (block[1] > t) out.push([t, block[1]]);
  return out;
}

// Sum the facts for a set of dates (and optionally one area).
function sum(facts, inRange, area = null, cfg = UTILIZATION) {
  const days = facts.days.filter((x) => !x.sunday && inRange(x.d) && (!area || x.area === area));
  const loose = facts.loose.filter((x) => !x.sunday && x.brand && inRange(x.d) && (!area || x.area === area));
  const add = (list, k) => list.reduce((m, x) => m + (x[k] || 0), 0) / 60;
  const unassigned = loose.filter((x) => x.kind === 'unassigned');
  const notTaking = loose.filter((x) => x.kind === 'not_taking');
  const avail = add(days, 'avail');
  const assigned = add(days, 'assigned');
  // All work: commercial bookings on these cleaners are committed time too.
  const commercial = facts.mode === 'residential' ? 0 : add(days, 'commercial');
  const unassignedH = add(unassigned, 'hours');
  const notTakingH = add(notTaking, 'hours');
  const travel = add(days, 'travel') + add(loose, 'travel');
  const spoken = assigned + commercial + unassignedH + notTakingH + travel;
  const left = avail - spoken;
  // Room for more bookings: how many typical bookings (plus a drive to each) fit into the open
  // stretches of each cleaner's day, less the unassigned visits that will need those slots.
  const visits = days.reduce((m, x) => m + x.visits, 0);
  const typical = visits ? assigned / visits : cfg.typicalBookingHours;
  const perBooking = typical + facts.avg_leg_min / 60;
  const slot = perBooking * 60;
  const fits = slot > 0 ? days.reduce((m, x) => m + (x.gaps || []).reduce((k, g) => k + Math.floor(g / slot), 0), 0) : 0;
  const room = Math.max(0, fits - unassigned.length - new Set(notTaking.map((x) => x.key)).size);
  return {
    closed: add(days, 'closed'), excluded: add(days, 'excluded'), avail, assigned, commercial, commercial_visits: facts.mode === 'residential' ? 0 : days.reduce((m, x) => m + (x.commercial_visits || 0), 0),
    unassigned: unassignedH, unassigned_visits: unassigned.length,
    not_taking: notTakingH, not_taking_visits: new Set(notTaking.map((x) => x.key)).size, travel, spoken, left,
    utilization: ratio(spoken, avail), room: left > 0 ? room : 0, typical,
  };
}
const rounded = (s) => ({
  closed_h: r1(s.closed), excluded_h: r1(s.excluded), available_h: r1(s.avail), assigned_h: r1(s.assigned), commercial_h: r1(s.commercial), commercial_visits: s.commercial_visits, unassigned_h: r1(s.unassigned), unassigned_visits: s.unassigned_visits,
  not_taking_h: r1(s.not_taking), not_taking_visits: s.not_taking_visits, travel_h: r1(s.travel),
  spoken_h: r1(s.spoken), left_h: r1(s.left), utilization: s.utilization, room_bookings: s.room, typical_booking_h: r1(s.typical),
});

// The dates that can be shown: from minFrom (past weeks; today if not given) until the end of the
// planner's copy.
export function clampRange(today, from, to, maxTo, minFrom = today) {
  const ok = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  let f = ok(from) ? from : today;
  let t = ok(to) ? to : addDays(today, 6);
  if (f < minFrom) f = minFrom;
  if (t < minFrom) t = minFrom;
  if (t > maxTo) t = maxTo;
  if (f > maxTo) f = maxTo;
  if (t < f) t = f;
  return { from: f, to: t };
}

/**
 * The whole report for the dates from..to (inclusive).
 * existing: Scheduling insights' own figures, for "Check the numbers":
 *   { capacity4, booked4, unassigned_visits, tolerance } (planner overview: its 4 weeks, and all future;
 *   tolerance = the rounding the planner applies, 0.05 h per cleaner-week)
 */
export function utilizationReport({ facts, from, to, maxTo, minFrom = null, cfg = UTILIZATION, existing = null, takenAt = null, cleaners: allCleaners = [], source = {} }) {
  const { today } = facts;
  const inWin = (d) => d >= from && d <= to;
  const all = sum(facts, inWin, null, cfg);
  const cust = facts.customers.filter((x) => !x.sunday && inWin(x.d));

  // Areas.
  const names = [...new Set([...cfg.areas, ...facts.days.map((x) => x.area), ...facts.loose.filter((x) => x.brand).map((x) => x.area)])];
  const areaSums = new Map();
  const areas = names.map((area) => {
    const s = sum(facts, inWin, area, cfg);
    areaSums.set(area, s);
    const ac = cust.filter((x) => x.area === area);
    return { area, cleaners: facts.taking.filter((c) => (c.area || 'Unknown') === area).length, customers: new Set(ac.map((x) => x.customer)).size, customers_recurring: new Set(ac.filter((x) => x.recurring).map((x) => x.customer)).size, ...rounded(s) };
  }).filter((a) => cfg.areas.includes(a.area) || a.cleaners || a.available_h || a.unassigned_h || a.assigned_h || a.commercial_h);

  // Cleaners, with their own travel; "if they left" = their booked + travel hours ÷ their area's hours left.
  const cleaners = facts.taking.map((c) => {
    const days = facts.days.filter((x) => x.cid === c.id && !x.sunday && inWin(x.d));
    const h = (k) => days.reduce((m, x) => m + x[k], 0) / 60;
    const avail = h('avail'), assigned = h('assigned'), travel = h('travel');
    const commercial = facts.mode === 'residential' ? 0 : h('commercial');
    // Shared cleaners: hours open in Launch27 vs hours already booked for commercial (residential only).
    const open = h('base') - h('closed'), otherBrand = h('other');
    const visits = days.reduce((m, x) => m + x.visits, 0);
    const legs = visits + (facts.mode === 'residential' ? 0 : days.reduce((m, x) => m + (x.commercial_visits || 0), 0));
    const area = c.area || 'Unknown';
    const left = areaSums.get(area)?.left ?? 0;
    const load = assigned + commercial + travel;
    // Room for more bookings in this cleaner's own open stretches.
    const typical = all.typical + facts.avg_leg_min / 60;
    const room = typical > 0 ? days.reduce((m, x) => m + (x.gaps || []).reduce((k, g) => k + Math.floor(g / (typical * 60)), 0), 0) : 0;
    return {
      cleaner_id: c.id, name: c.name, area, status_label: c.status_label || null, visits, commercial_visits: legs - visits,
      other_locations: !!days.some((x) => x.extra),
      open_h: r1(open), other_brand_h: r1(otherBrand), available_h: r1(avail), assigned_h: r1(assigned), commercial_h: r1(commercial), travel_h: r1(travel), travel_per_visit_min: legs ? Math.round((travel * 60) / legs) : null,
      left_h: r1(avail - load), utilization: ratio(load, avail), room_bookings: avail - load > 0 ? room : 0,
      // null + area_short: their area already has no hours left.
      if_left: load > 0 && left > 0 ? load / left : load > 0 ? null : 0, area_short: load > 0 && left <= 0,
    };
  }).sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));

  // By day (Monday–Saturday) in the chosen dates.
  const byDay = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!cfg.operatingDays.includes(weekday(d))) continue;
    const one = (x) => x === d;
    byDay.push({ date: d, ...rounded(sum(facts, one, null, cfg)), areas: Object.fromEntries(areas.map((a) => [a.area, rounded(sum(facts, one, a.area, cfg))])) });
  }

  // Weekly chart: utilization per area, each of the next N weeks (week 1 from today).
  const start = mondayOf(today);
  const trend = Array.from({ length: cfg.trendWeeks }, (_, i) => addDays(start, i * 7)).map((wk) => {
    const inWk = (d) => d >= wk && d <= addDays(wk, 6) && d >= today;
    return { week: wk, total: sum(facts, inWk, null, cfg).utilization, areas: Object.fromEntries(areas.map((a) => [a.area, sum(facts, inWk, a.area, cfg).utilization])) };
  });

  // Check the numbers: Scheduling insights' figures, step by step to this page's. Scheduling
  // insights counts each cleaner's day from first start to last end, every booking in full, all
  // locations, for the cleaners in the viewed locations.
  let reconcile = null;
  if (existing) {
    const four = addDays(mondayOf(today), 27);
    const d4 = facts.days.filter((x) => x.d >= today && x.d <= four);
    const h = (list, k) => list.reduce((m, x) => m + (x[k] || 0), 0) / 60;
    const own = d4.filter((x) => !x.extra);
    const added = d4.filter((x) => x.extra && !x.sunday);
    const sundays = own.filter((x) => x.sunday);
    const weekdays = own.filter((x) => !x.sunday);
    const residential = facts.mode === 'residential';
    const capSteps = {
      existing: existing.capacity4, sundays: h(sundays, 'window'), breaks: h(weekdays, 'window') - h(weekdays, 'base') - h(weekdays, 'excluded'), excluded: h(weekdays, 'excluded'),
      closed: h(weekdays, 'closed'), other_brand: h(weekdays, 'other'), floor: h(weekdays, 'base') - h(weekdays, 'closed') - h(weekdays, 'other') - h(weekdays, 'avail'),
      added: -h(added, 'avail'), result: h([...weekdays, ...added], 'avail'),
    };
    const bookSteps = {
      existing: existing.booked4, sundays: h(sundays, 'assigned') + h(sundays, 'commercial'), other_brand: residential ? h(weekdays, 'commercial') : 0,
      added: -(h(added, 'assigned') + (residential ? 0 : h(added, 'commercial'))),
      result: h([...weekdays, ...added], 'assigned') + (residential ? 0 : h([...weekdays, ...added], 'commercial')),
    };
    const un = facts.loose.filter((x) => x.kind === 'unassigned' && x.d >= today);
    const unSteps = { existing: existing.unassigned_visits, other_brand: un.filter((x) => !x.brand).length, sundays: un.filter((x) => x.brand && x.sunday).length, outside: un.filter((x) => x.brand && !x.sunday && !inWin(x.d)).length, result: un.filter((x) => x.brand && !x.sunday && inWin(x.d)).length };
    const tol = existing.tolerance ?? 0.5;
    const tie = (s, keys) => s.existing != null && Math.abs(keys.reduce((m, k) => m - s[k], s.existing) - s.result) <= tol;
    const r1all = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r1(v) : v]));
    reconcile = {
      mode: facts.mode,
      capacity: { ...r1all(capSteps), ties: tie(capSteps, ['sundays', 'breaks', 'excluded', 'closed', 'other_brand', 'floor', 'added']) },
      booked: { ...r1all(bookSteps), ties: tie(bookSteps, ['sundays', 'other_brand', 'added']) },
      unassigned: { ...unSteps, ties: unSteps.existing - unSteps.other_brand - unSteps.sundays - unSteps.outside === unSteps.result },
      hours_from: today, hours_to: four,
    };
  }

  return {
    taken_at: takenAt, today, from, to, max_to: maxTo, min_from: minFrom || today, past: to < today, avg_leg_min: Math.round(facts.avg_leg_min), mode: facts.mode, split: !!facts.split,
    data_check: dataCheck({ facts, inWin, cleaners: allCleaners, source, from, to, cfg }),
    totals: { ...rounded(all), cleaners: facts.taking.length, customers: new Set(cust.map((x) => x.customer)).size, customers_recurring: new Set(cust.filter((x) => x.recurring).map((x) => x.customer)).size },
    areas, cleaners, by_day: byDay, trend, reconcile,
    needs_cleaner: needsCleaner(facts, inWin),
  };
}

// Data check: per cleaner, what the report knows from Launch27 and what looks wrong, for the dates
// shown. Cleaners taking bookings, plus anyone else with bookings in these dates.
const FLAG = {
  refused: 'Launch27 refused their hours',
  booked_no_hours: 'Booked, but 0 available hours',
  booked_not_taking: 'Booked, but not taking bookings',
  over_availability: 'Booked past their available hours',
  low_hours: 'Under 60% of their Launch27 weekly hours',
  no_hours: 'No hours set in Launch27',
  no_home: 'No home location (area Unknown)',
};
const FLAG_ORDER = Object.keys(FLAG);
export const LOW_HOURS_SHARE = 0.6;
export function dataCheck({ facts, inWin, cleaners = [], source = {}, from = null, to = null, cfg = UTILIZATION }) {
  const takingIds = new Set(facts.taking.map((c) => c.id));
  const blank = () => ({ avail: 0, booked: 0, commercial: 0, over: 0, excluded: 0, excluded_days: 0, visits: 0, open: 0, other: 0 });
  // Launch27 weekly hours over the dates shown (Monday–Saturday), to compare with the report's.
  const dates = [];
  if (from && to) for (let d = from; d <= to; d = addDays(d, 1)) if (cfg.operatingDays.includes(weekday(d))) dates.push(d);
  const weeklyFor = (c) => {
    const rows = (c.availability || []).filter((r) => !r.date);
    return dates.reduce((m, d) => m + workingMinutes(rows, d), 0);
  };
  const per = new Map();
  for (const x of facts.days) {
    if (x.sunday || !inWin(x.d)) continue;
    const p = per.get(x.cid) || blank();
    p.avail += x.avail;
    p.open += x.base - x.closed;
    p.other += x.other;
    p.booked += x.assigned;
    p.commercial += x.commercial || 0;
    p.over += x.over || 0;
    p.excluded += x.excluded || 0;
    p.excluded_days += x.excluded ? 1 : 0;
    p.visits += x.visits;
    per.set(x.cid, p);
  }
  for (const x of facts.loose) {
    if (x.kind !== 'not_taking' || x.sunday || !x.brand || !inWin(x.d)) continue;
    const p = per.get(x.cid) || blank();
    p.booked += x.hours;
    p.visits += 1;
    per.set(x.cid, p);
  }
  const rows = [];
  for (const c of cleaners) {
    const taking = takingIds.has(c.id);
    const p = per.get(c.id) || blank();
    if (!taking && !p.visits) continue;
    const weeklyMin = taking ? weeklyFor(c) : 0;
    // All work: hours open in Launch27 (commercial is not taken off); residential only: what's left.
    const reportMin = facts.mode === 'residential' ? p.avail : p.open;
    const weekly = (c.availability || []).filter((r) => !r.date);
    const weeklyH = c.weekly_hours ?? null;
    const flags = [];
    if (c.availability_error) flags.push('refused');
    if (taking && p.visits && p.avail <= 0) flags.push('booked_no_hours');
    if (!taking && p.visits) flags.push('booked_not_taking');
    if (taking && p.over >= 1) flags.push('over_availability');
    if (taking && weeklyMin > 0 && reportMin < weeklyMin * LOW_HOURS_SHARE) flags.push('low_hours');
    if (!c.availability_error && taking && !(weeklyH > 0)) flags.push('no_hours');
    if (c.lat == null || c.lng == null) flags.push('no_home');
    rows.push({
      cleaner_id: c.id, name: c.name, status_label: c.status_label || null, taking, area: c.area || 'Unknown',
      home_location: c.lat != null && c.lng != null, weekly_hours: weeklyH, weekly_rows: weekly.length, dated_rows: (c.availability || []).length - weekly.length,
      availability_error: c.availability_error || null,
      // Exactly what Launch27 sent (weekly rows, and a few date rows), to compare with its screen.
      sent: {
        weekly: weekly.slice(0, 14).map((r) => ({ weekday: r.weekday ?? null, start: r.start_time ?? null, end: r.end_time ?? null, dayoff: !!r.dayoff })),
        dated: (c.availability || []).filter((r) => r.date).slice(0, 6).map((r) => ({ date: String(r.date).slice(0, 10), weekday: r.weekday ?? null, start: r.start_time ?? null, end: r.end_time ?? null, dayoff: !!r.dayoff })),
        dated_total: (c.availability || []).filter((r) => r.date).length,
      },
      open_h: r1(p.open / 60), other_brand_h: r1(p.other / 60), available_h: r1(p.avail / 60), booked_h: r1(p.booked / 60), commercial_h: r1(p.commercial / 60), visits: p.visits,
      over_h: r1(p.over / 60), weekly_window_h: taking ? r1(weeklyMin / 60) : null, report_h: taking ? r1(reportMin / 60) : null, excluded_h: r1(p.excluded / 60), excluded_days: p.excluded_days,
      flags: flags.map((k) => ({ kind: k, label: FLAG[k] })),
    });
  }
  const rank = (r) => (r.flags.length ? Math.min(...r.flags.map((f) => FLAG_ORDER.indexOf(f.kind))) : 99);
  rows.sort((a, b) => rank(a) - rank(b) || b.booked_h - a.booked_h || a.name.localeCompare(b.name));
  const counts = Object.fromEntries(FLAG_ORDER.map((k) => [k, rows.filter((r) => r.flags.some((f) => f.kind === k)).length]));
  // Bookings for partners (Carefor, OWCS, hospital programs, homemaking) filed under a residential
  // location: probably commercial work in the wrong location.
  const seen = new Set();
  const bookings = [];
  for (const x of facts.partner_checks || []) {
    if (x.sunday || !inWin(x.d) || seen.has(x.v.key)) continue;
    seen.add(x.v.key);
    const v = x.v;
    bookings.push({ key: v.key, booking_id: v.id || null, date: v.date, start: v.start, hours: r1((Number(v.duration) || 0) / 60), customer: v.customer || null, account: v.account_name || null, partner: v.partner_name || null, location_id: v.location_id ?? null, cleaners: v.team_ids.map((id) => cleaners.find((c) => c.id === id)?.name || null).filter(Boolean) });
  }
  bookings.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  return { refreshed_at: source.full_at || null, read_by: source.cleaners_by || null, counts, labels: FLAG, cleaners: rows, low_hours_share: LOW_HOURS_SHARE, partner_bookings: bookings.slice(0, 500), partner_bookings_total: bookings.length };
}

// The bookings behind "Unassigned" (no cleaner yet) and "On cleaners not taking bookings" (to move),
// in the chosen dates, Monday to Saturday, for the drill-down list.
export function needsCleaner(facts, inWin) {
  const seen = new Set();
  const out = [];
  for (const x of facts.loose) {
    if (x.sunday || !x.brand || !inWin(x.d) || !x.v) continue;
    const k = `${x.kind}|${x.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const v = x.v;
    out.push({
      kind: x.kind, key: v.key, booking_id: v.id || null, projected: !v.id, date: v.date, start: v.start, hours: r1(v.duration / 60),
      customer: v.customer || null, area: x.area, freq: v.freq || null, address: v.addr || null, cleaner: x.cleaner || null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start).slice(0, 1000);
}

// Past days from the daily record replace the same days rebuilt from today's planner copy (which
// only knows cleaners' current weekly hours). `recorded` = facts built from each saved day.
export function withRecordedDays(live, recorded = []) {
  if (!recorded.length) return live;
  const days = new Set(recorded.flatMap((f) => f.recorded_days || []));
  const keep = (x) => !days.has(x.d);
  const taking = new Map(live.taking.map((c) => [c.id, c]));
  for (const f of recorded) for (const c of f.taking) if (!taking.has(c.id)) taking.set(c.id, c);
  return {
    ...live,
    days: [...live.days.filter(keep), ...recorded.flatMap((f) => f.days)],
    loose: [...live.loose.filter(keep), ...recorded.flatMap((f) => f.loose)],
    customers: [...live.customers.filter(keep), ...recorded.flatMap((f) => f.customers)],
    taking: [...taking.values()],
    recorded_days: [...days].sort(),
  };
}
