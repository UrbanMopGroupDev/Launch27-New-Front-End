// Pure calculations over the 12-month Launch27 visit snapshot (reports/service.js):
//   journeyAt   – the client as of the complaint (tenure, frequency, spend, cleaner changes…)
//   outcomeAt   – SAVED / PARTIAL SAVE / LOST / pending at day 30, 60, 90
//   recleanCost – what a reclean really costs (labour + travel + the lost slot's margin)
// Visits: { id, date 'YYYY-MM-DD', at ms, revenue, freq, customer_id, teams:[{id,name,hours,earned}], rating:{r,comment} }

const DAY = 86_400_000;
const days = (a, b) => Math.round((b - a) / DAY);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** visitsByCustomer: Map(customer_id -> visits sorted by time). at: complaint time (ms). */
export function journeyAt(list, at, { priorCases = [], cleanerStatsAt = null, dataFrom = null, complainedVisitId = null } = {}) {
  const before = (list || []).filter((v) => v.at < at);
  const last = before[before.length - 1] || null;
  const first = before[0] || null;
  const last90 = before.filter((v) => v.at >= at - 90 * DAY);
  const cleaners90 = new Set(last90.flatMap((v) => v.teams.map((t) => t.id)));
  const prevTeam = before.length >= 2 ? before[before.length - 2].teams.map((t) => t.id).sort().join(',') : null;
  const lastTeam = last ? last.teams.map((t) => t.id).sort().join(',') : null;
  const prices = before.slice(-4).map((v) => v.revenue).filter((x) => x > 0);
  const priceChange = prices.length >= 2 ? (prices[prices.length - 1] - mean(prices.slice(0, -1))) / mean(prices.slice(0, -1)) : null;
  const cleaner = last?.teams?.[0] || null;
  const cs = cleaner && cleanerStatsAt ? cleanerStatsAt(cleaner.id, at) : null;
  return {
    tenure_days: first ? days(first.at, at) : null,
    frequency: last?.freq || null,
    cleans_total: before.length,
    spend_12m: Math.round(before.filter((v) => v.at >= at - 365 * DAY).reduce((s, v) => s + (v.revenue || 0), 0) * 100) / 100,
    price_change_pct: priceChange == null ? null : Math.round(priceChange * 1000) / 1000,
    distinct_cleaners_90d: cleaners90.size,
    cleaner_changed_last_visit: prevTeam != null && lastTeam != null ? prevTeam !== lastTeam : null,
    prior_complaints: priorCases.filter((c) => c.opened_at < at && c.opened_at >= at - 365 * DAY).length,
    prior_unhappy_ratings: before.filter((v) => v.id !== complainedVisitId && v.rating && v.rating.r === 0).length,
    days_since_last_clean: last ? days(last.at, at) : null,
    cleaner_id: cleaner?.id ?? null,
    cleaner_name: cleaner?.name ?? null,
    cleaner_visits_before: cs?.visits ?? null,
    cleaner_unhappy_rate_90d: cs?.unhappyRate ?? null,
    data_from: dataFrom,
  };
}

/** Per-cleaner experience and unhappy-rating rate before a moment, from all visits. */
export function cleanerStatsIndex(visits) {
  const byCleaner = new Map();
  for (const v of visits) for (const t of v.teams) {
    if (!byCleaner.has(t.id)) byCleaner.set(t.id, []);
    byCleaner.get(t.id).push(v);
  }
  for (const l of byCleaner.values()) l.sort((a, b) => a.at - b.at);
  return (id, at) => {
    const l = (byCleaner.get(id) || []).filter((v) => v.at < at);
    const recent = l.filter((v) => v.at >= at - 90 * DAY && v.rating);
    return { visits: l.length, unhappyRate: recent.length >= 5 ? Math.round((recent.filter((v) => v.rating.r === 0).length / recent.length) * 1000) / 1000 : null };
  };
}

/**
 * Outcome checked `day` days after the complaint (briefed definitions):
 *   saved        – still booking 60+ days after, and no 1–2★ public review
 *   partial_save – left after day 60, no negative public review
 *   lost         – stopped booking within 60 days, and/or a 1–2★ public review
 *   pending      – too early to tell (the 30-day check is never final)
 * "Still booking at the mark" = a visit or an upcoming booking on/after the mark, or a last
 * visit within the client's normal gap before it (21 days; 35 for monthly clients), once
 * that gap has fully passed.
 */
export function outcomeAt(list, at, day, { today, upcoming = [], negativeReview = null, repeatCaseId = null }) {
  const mark = at + day * DAY;
  const all = [...(list || []), ...upcoming].sort((a, b) => a.at - b.at);
  const after = all.filter((v) => v.at > at);
  const last = all.filter((v) => v.at <= Math.max(today, mark)).slice(-1)[0] || all[all.length - 1] || null;
  const grace = /month|4 ?week/i.test(String(last?.freq || '')) ? 35 : 21;
  const negative = negativeReview?.stars != null && negativeReview.stars <= 2;
  const base = {
    day,
    next_booking_on: after[0]?.date || null,
    last_booking_on: (list || []).filter((v) => v.at <= today).slice(-1)[0]?.date || null,
    public_review_stars: negativeReview?.stars ?? null,
    public_review_platform: negativeReview?.platform ?? null,
    repeat_case_id: repeatCaseId,
  };
  const bookedPast = (m) => after.some((v) => v.at >= m);
  const goneBy = (m) => !bookedPast(m - grace * DAY) && today >= m; // nothing in the last normal gap before m
  if (negative) return { ...base, still_booking: bookedPast(mark), outcome: 'lost' };
  if (bookedPast(mark)) return { ...base, still_booking: true, outcome: day >= 60 ? 'saved' : 'pending' };
  if (today < mark + grace * DAY && !goneBy(mark)) return { ...base, still_booking: null, outcome: 'pending' };
  // Not booking at the mark. When did they leave?
  const lastAfter = after.filter((v) => v.at <= today).slice(-1)[0];
  const leftWithin60 = !lastAfter || lastAfter.at + grace * DAY < at + 60 * DAY;
  return { ...base, still_booking: false, outcome: leftWithin60 ? 'lost' : 'partial_save' };
}

/**
 * Real cost of a reclean. Labour = what the cleaner earns for it (hours × their effective
 * hourly pay on recent visits, or the setting's default). Travel = the setting's flat
 * per-visit travel cost. Lost slot = the average gross margin of a residential visit of that
 * length that week (revenue − cleaner pay), because the reclean occupies a bookable slot.
 */
export function recleanCost({ hours, cleanerHourly, marginPerHour, travel, spot = false }, settings) {
  const h = (hours || settings.reclean_default_hours) * (spot ? settings.reclean_spot_share : 1);
  const labour = h * (cleanerHourly || settings.cleaner_hourly_default);
  const slot = h * (marginPerHour ?? settings.margin_per_hour_default);
  return { hours: Math.round(h * 10) / 10, labour: Math.round(labour * 100) / 100, travel: travel ?? settings.travel_per_visit, lost_slot: Math.round(slot * 100) / 100, total: Math.round((labour + (travel ?? settings.travel_per_visit) + slot) * 100) / 100 };
}

/** Effective cleaner hourly pay and gross margin per hour over recent residential visits. */
export function unitEconomics(visits, sinceMs) {
  let pay = 0;
  let hours = 0;
  let revenue = 0;
  for (const v of visits) {
    if (v.at < sinceMs) continue;
    for (const t of v.teams) {
      if (t.earned == null || !t.hours) continue;
      pay += t.earned;
      hours += t.hours;
    }
    if (v.teams.every((t) => t.earned != null && t.hours)) revenue += v.revenue || 0;
  }
  if (!hours) return { cleanerHourly: null, marginPerHour: null };
  return { cleanerHourly: Math.round((pay / hours) * 100) / 100, marginPerHour: Math.round(((revenue - pay) / hours) * 100) / 100 };
}
