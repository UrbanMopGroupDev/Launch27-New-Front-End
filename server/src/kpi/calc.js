// KPI scorecard calculations. Pure functions over a normalized dataset (see connectors.js
// for its shape): no database, no network, no clock except the `now` passed in. Every
// formula and exclusion rule on the scorecard lives in this file and is tested in
// server/test/kpi.test.js. The UI only renders what these functions return.
import { reviewRows, starCounts } from './review-details.js';
import { KPI_RULES, KPI_LABELS, KPI_SOURCES } from './config.js';

// ---------- dates (local calendar strings: 'YYYY-MM-DD', 'YYYY-MM', 'YYYY-MM-DDTHH:MM') ----------
const DAY = 86_400_000;
export const monthOf = (d) => String(d).slice(0, 7);
export const dayOf = (t) => String(t).slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(`${dayOf(d)}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const addMonths = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const monthStart = (m) => `${m}-01`;
export const monthEnd = (m) => addDays(monthStart(addMonths(m, 1)), -1);
export const monthsBetween = (from, to) => {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
};
const ms = (t) => Date.parse(String(t).length <= 10 ? `${t}T00:00:00Z` : `${String(t).slice(0, 16)}:00Z`);
const daysApart = (a, b) => Math.abs(ms(dayOf(a)) - ms(dayOf(b))) / DAY;
export const monthLabel = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Last closed month: the previous month once its books are closed (closeDay), else the one before. */
export function lastClosedMonth(today, rules = KPI_RULES) {
  const prev = addMonths(monthOf(today), -1);
  return Number(today.slice(8, 10)) >= rules.closeDay ? prev : addMonths(prev, -1);
}

// ---------- classification rules ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export function isRecurring(frequency, rules = KPI_RULES) {
  const f = norm(frequency).replace(/-/g, '');
  if (/one ?time/.test(f)) return false;
  return rules.recurringWords.some((w) => f.includes(w));
}
export function isTest(name, reason, rules = KPI_RULES) {
  const n = norm(name);
  if (rules.testNames.includes(n)) return true;
  return /\btest\b/.test(n) || /\btest\b/.test(norm(reason));
}
export function isInstitutional(name, rules = KPI_RULES) {
  const n = norm(name);
  return rules.institutional.some((w) => n.includes(w));
}
/** Category of a cancellation reason: luxo_transfer | temporary | admin_error | null (none of those). */
export function reasonCategory(reason, rules = KPI_RULES) {
  return rules.reasonCategories.find((c) => c.pattern.test(String(reason || ''))) || null;
}
export function churnBand(pct, rules = KPI_RULES) {
  return rules.churnBands.find((b) => pct <= b.max);
}
export function isOverCancel(cancellation, rules = KPI_RULES) {
  if (!cancellation || cancellation.by !== 'staff') return false;
  const r = norm(cancellation.reason).replace(/-/g, ' ');
  return rules.overCancelWords.some((w) => r.includes(w));
}
/** Who caused a cancellation: { cause: 'company' | 'client' | 'unclassified', label }. */
export function cancellationCause(cancellation, rules = KPI_RULES) {
  const reason = String(cancellation?.reason || '');
  const company = rules.companyCauses.find((c) => c.pattern.test(reason));
  if (company) return { cause: 'company', label: company.label };
  if (cancellation?.by === 'customer') return { cause: 'client', label: 'Client cancelled' };
  if (rules.clientCausePattern.test(reason)) return { cause: 'client', label: 'Client request (entered by staff)' };
  return { cause: 'unclassified', label: 'Unclassified staff cancellation' };
}

export const FULFILMENT_GROUPS = { done: 'Fulfilled', company: 'Ours (controllable)', client: 'Client-related', unclassified: 'Unclear reason' };

// ---------- index ----------
const push = (map, key, v) => (map.get(key) || map.set(key, []).get(key)).push(v);

export function indexDataset(ds) {
  const ix = { ds, byCustomer: new Map(), byMonth: new Map(), cancelsByMonth: new Map(), complaintsByMonth: new Map(), complaintsByCustomer: new Map(), badRatingsByMonth: new Map(), reviewsByMonth: new Map(), qbo: new Map(), syft: new Map() };
  const bookings = [...(ds.bookings || [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  for (const b of bookings) {
    push(ix.byCustomer, b.customer_id, b);
    push(ix.byMonth, monthOf(b.date), b);
    if (b.cancellation) push(ix.cancelsByMonth, monthOf(b.cancellation.at), b);
    if (b.rating === 0 && b.rated_at) push(ix.badRatingsByMonth, monthOf(b.rated_at), b);
  }
  for (const c of ds.complaints || []) {
    push(ix.complaintsByMonth, monthOf(c.date), c);
    push(ix.complaintsByCustomer, c.customer_id, c);
  }
  for (const r of ds.reviews || []) push(ix.reviewsByMonth, monthOf(r.date), r);
  for (const q of ds.ocr?.qbo || []) ix.qbo.set(q.month, q);
  for (const s of ds.ocr?.syft || []) ix.syft.set(s.month, s);
  return ix;
}

/** Items from a by-month map whose date falls inside from..to (inclusive). */
const inWindow = (map, from, to, dateOf) => monthsBetween(monthOf(from), monthOf(to)).flatMap((m) => map.get(m) || []).filter((x) => dateOf(x) >= from && dateOf(x) <= to);
export const dayLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// ---------- source freshness ----------
/** 'ok' | 'stale' | 'missing' for one source. Monthly sources (QBO, Syft) never go stale by age. */
export function sourceState(source, key, now, rules = KPI_RULES) {
  if (!source || !source.refreshed_at) return 'missing';
  // A one-off export has a fixed date: it does not go stale by age, and says what it is on the tile.
  if (source.static) return 'ok';
  if (KPI_SOURCES[key]?.daily && now - Date.parse(source.refreshed_at) > rules.staleHours * 3_600_000) return 'stale';
  return 'ok';
}
function sourcesFor(ix, keys, now, rules) {
  const list = keys.map((key) => ({ key, label: KPI_SOURCES[key].label, refreshed_at: ix.ds.sources?.[key]?.refreshed_at || null, note: ix.ds.sources?.[key]?.note || null, state: sourceState(ix.ds.sources?.[key], key, now, rules) }));
  const state = list.some((s) => s.state === 'missing') ? 'no_data' : list.some((s) => s.state === 'stale') ? 'stale' : 'ok';
  return { list, state };
}

// ---------- 1. OCR ----------
/** Operational delivery cost ÷ revenue for one month, from QBO, cross-checked against Syft. */
export function ocrMonth(ix, month, today, rules = KPI_RULES) {
  const q = ix.qbo.get(month);
  const s = ix.syft.get(month);
  const status = today >= `${addMonths(month, 1)}-${String(rules.closeDay).padStart(2, '0')}` ? 'Final' : 'Provisional';
  const lines = (q?.lines || []).map((l) => ({ ...l, included: l.category in rules.ocrIncluded, group: rules.ocrIncluded[l.category] || rules.ocrExcluded[l.category] || 'Not operational delivery' }));
  const cost = lines.filter((l) => l.included).reduce((t, l) => t + l.amount, 0);
  const ok = !!q && q.revenue > 0;
  const qboPct = ok ? (cost / q.revenue) * 100 : null;
  const syftPct = s?.ocr_pct ?? null;
  const diff = qboPct != null && syftPct != null ? qboPct - syftPct : null;
  const syftInfo = { syft: syftPct, syft_received: s?.received_at || null, syft_file: s?.file || null, syft_income: s?.income ?? null };
  // QuickBooks is the source of truth. Until it is connected, the figure the Syft report
  // states is shown as it is, clearly marked, with no cross-check.
  if (!ok && syftPct != null) {
    const income = s.income || 0;
    return { month, state: 'ok', basis: 'syft', value: syftPct, num: (income * syftPct) / 100, den: income, status, ...syftInfo, diff: null, flagged: false, lines: [], revenue: s.income ?? null };
  }
  return { month, state: ok ? 'ok' : 'no_data', basis: 'qbo', value: qboPct, num: ok ? cost : 0, den: ok ? q.revenue : 0, status, ...syftInfo, diff, flagged: diff != null && Math.abs(diff) > rules.ocrFlagPp, lines, revenue: q?.revenue ?? null };
}

// ---------- 2. Churn ----------
const SEGMENT_LABEL = { prepaid: 'Prepaid', payg: 'Pay-as-you-go' };

/** 'prepaid' when the Launch27 frequency name says so; otherwise pay-as-you-go. */
export const churnSegment = (frequency) => (/pre-?paid/i.test(String(frequency || '')) ? 'prepaid' : 'payg');
const activeRecurring = (ix, customerId, rules) => (ix.byCustomer.get(customerId) || []).filter((b) => !b.cancellation && isRecurring(b.frequency, rules));
// What happened after a client stopped on `on` (a cancellation date, or their last prepaid visit):
// 'none' = no recurring visit in the return window (permanent); 'temporary' = back inside the
// window after more than temporaryGapDays between cleans; 'continued' = a skipped or moved visit.
function returnAfter(ix, customerId, on, rules) {
  const list = activeRecurring(ix, customerId, rules);
  const next = list.find((b) => b.date > on);
  if (!next || next.date > addDays(on, rules.temporaryReturnDays)) return { kind: 'none' };
  const prev = [...list].reverse().find((b) => b.date < next.date);
  const gap = prev ? Math.round(daysApart(next.date, prev.date)) : null;
  const days = Math.round(daysApart(next.date, on));
  return { kind: gap != null && gap > rules.temporaryGapDays ? 'temporary' : 'continued', days, gap };
}
// 'series' = Launch27 says this and all future recurring bookings were cancelled; 'single' = this
// booking only; null = Launch27 gave no type (older bookings). Any booking the client cancelled
// on the same day decides it, since cancelling a plan cancels several bookings at once.
function cancelScope(ix, b, rules) {
  const day = dayOf(b.cancellation.at);
  const types = (ix.byCustomer.get(b.customer_id) || []).filter((x) => x.cancellation && dayOf(x.cancellation.at) === day).map((x) => x.cancellation.type).filter(Boolean);
  if (!types.length) return null;
  return types.some((t) => rules.seriesCancelPattern.test(t)) ? 'series' : 'single';
}
const SCOPE_LABEL = { series: 'All future visits', single: 'This visit only' };
// Came back inside the window: temporary churn when the whole plan was cancelled (or, with no
// type from Launch27, when more than temporaryGapDays passed between cleans); otherwise a skip.
const wasTemporary = (scope, back) => back.kind !== 'none' && (scope === 'series' || (scope == null && back.kind === 'temporary'));
// Prepaid plans that ran out: a client's active prepaid visit with no recurring visit after it
// inside temporaryGapDays. Indexed once per dataset by the month of that last visit.
function prepaidEnds(ix, rules) {
  if (ix.prepaidEnds) return ix.prepaidEnds;
  const map = new Map();
  for (const [customerId, all] of ix.byCustomer) {
    if (!all.some((b) => churnSegment(b.frequency) === 'prepaid')) continue;
    const list = activeRecurring(ix, customerId, rules);
    list.forEach((b, i) => {
      if (churnSegment(b.frequency) !== 'prepaid') return;
      const next = list[i + 1];
      if (next && daysApart(next.date, b.date) <= rules.temporaryGapDays) return;
      push(map, monthOf(b.date), b);
    });
  }
  ix.prepaidEnds = map;
  return map;
}

const lastCleaner = (ix, booking) => {
  const upTo = booking.cancellation ? dayOf(booking.cancellation.at) : booking.date;
  const done = (ix.byCustomer.get(booking.customer_id) || []).filter((b) => b.completed && b.date <= upTo);
  return done.length ? done[done.length - 1].cleaner : booking.cleaner || null;
};

/**
 * Permanent recurring churn for one calendar month.
 * events ÷ active recurring clients at the start of the month. Every cancellation in the
 * month is returned with the rule that counted or excluded it, so the number can be audited.
 */
export function churnMonth(ix, month, today, rules = KPI_RULES, win = null) {
  // The blended tile, the two plan tiles and the trends all ask for the same periods: work each out once.
  const memoKey = `${month}|${win?.from || ''}|${win?.to || ''}|${today}`;
  ix.churnMemo = ix.churnMemo || new Map();
  if (rules === KPI_RULES && ix.churnMemo.has(memoKey)) return ix.churnMemo.get(memoKey);
  const out = churnCalc(ix, month, today, rules, win);
  if (rules === KPI_RULES) ix.churnMemo.set(memoKey, out);
  return out;
}
/** One plan type's share of a churn result: its own events, starting clients and rate. */
export function churnForSegment(res, key, rules = KPI_RULES) {
  const g = res.segments[key];
  const label = SEGMENT_LABEL[key];
  const value = g.den ? (g.permanent / g.den) * 100 : null;
  const events = res.events.filter((e) => e.segment === label);
  return { ...res, state: g.den ? 'ok' : 'no_data', value, num: g.permanent, den: g.den, band: value == null ? null : churnBand(value, rules), events, base: res.base.filter((x) => x.seg === key), over_cancel: res.over_cancel.filter((e) => e.segment === label), pending: events.filter((e) => e.outcome.startsWith('Pending')).length, temporary: g.temporary, provisional: g.provisional, plan_ends: key === 'prepaid' ? res.plan_ends : 0, segment: key };
}
const CHURN_SEGMENT = { churn_prepaid: 'prepaid', churn_payg: 'payg' };
const isChurn = (kpi) => kpi === 'churn' || kpi in CHURN_SEGMENT;
const churnFor = (kpi, res, rules) => (kpi in CHURN_SEGMENT ? churnForSegment(res, CHURN_SEGMENT[kpi], rules) : res);
function churnCalc(ix, month, today, rules, win) {
  // `win` narrows it to exact dates (a custom range): events dated inside it ÷ clients active at its start.
  const from = win?.from || monthStart(month);
  const to = win?.to || monthEnd(month);
  const start = from;
  const cancels = [...(win ? inWindow(ix.cancelsByMonth, from, to, (b) => dayOf(b.cancellation.at)) : ix.cancelsByMonth.get(month) || [])].sort((a, b) => (a.cancellation.at < b.cancellation.at ? -1 : 1));
  const counted = new Set();
  const temporary = new Map(); // customer -> segment: left and came back inside the return window
  const provisional = new Set(); // counted, but still inside the return window
  const segOf = new Map(); // counted customer -> segment
  const mark = (b, on) => {
    counted.add(b.customer_id);
    segOf.set(b.customer_id, churnSegment(b.frequency));
    if (today < addDays(on, rules.temporaryReturnDays)) provisional.add(b.customer_id);
  };
  const events = cancels.map((b) => {
    const c = b.cancellation;
    const scope = cancelScope(ix, b, rules);
    const row = { scope: SCOPE_LABEL[scope] || '', segment: isRecurring(b.frequency, rules) ? SEGMENT_LABEL[churnSegment(b.frequency)] : '', booking_id: b.id, customer_id: b.customer_id, customer: b.customer, cancelled_on: dayOf(c.at), service_date: b.date, frequency: b.frequency, reason: c.reason || '', cancelled_by: c.by === 'staff' ? `Staff${c.by_name ? ` (${c.by_name})` : ''}` : 'Client', last_cleaner: lastCleaner(ix, b), over_cancel: isOverCancel(c, rules) };
    const cat = reasonCategory(c.reason, rules);
    let outcome = null;
    if (isTest(b.customer, c.reason, rules)) outcome = 'Excluded: test entry';
    else if (isInstitutional(b.customer, rules)) outcome = 'Excluded: institutional client';
    else if (!isRecurring(b.frequency, rules)) outcome = 'Excluded: one-time booking';
    else if (cat?.key === 'temporary') {
      // Temporary (travel, hold…): not churn if they are back on a recurring plan within the
      // return window; churn if the window has passed with no return; pending until then.
      const on = dayOf(c.at);
      const back = returnAfter(ix, b.customer_id, on, rules);
      if (back.kind !== 'none') {
        outcome = `Excluded: temporary, back within ${rules.returnBuckets.find((d) => back.days <= d)} days`;
        if (wasTemporary(scope, back)) temporary.set(b.customer_id, churnSegment(b.frequency));
      } else if (today < addDays(on, rules.temporaryReturnDays)) outcome = `Pending: temporary, inside the ${rules.temporaryReturnDays}-day return window`;
      else if (counted.has(b.customer_id)) outcome = 'Excluded: second event this month';
      else row.note = `temporary, no return within ${rules.temporaryReturnDays} days`;
    } else if (cat) outcome = `Excluded: ${cat.label.toLowerCase()}`;
    else {
      const back = returnAfter(ix, b.customer_id, dayOf(c.at), rules);
      if (wasTemporary(scope, back)) {
        outcome = `Excluded: temporary churn, came back after ${back.days} days (${scope === 'series' ? 'cancelled all future visits' : `${back.gap} days between cleans`})`;
        temporary.set(b.customer_id, churnSegment(b.frequency));
      } else if (back.kind !== 'none') outcome = 'Excluded: came back (skipped or moved visit, recurring visits continued)';
      else if (counted.has(b.customer_id)) outcome = 'Excluded: second event this month';
    }
    if (!outcome) mark(b, dayOf(c.at));
    if (!outcome && scope === 'single') row.note = row.note || 'cancelled one visit, then no recurring visit after';
    return { ...row, counted: !outcome, outcome: outcome || (row.note ? `Counted as churn (${row.note})` : 'Counted as churn') };
  });

  // Prepaid plans that ended in the period with no renewal: churn dated the last prepaid visit,
  // with the same return test. A plan whose last visit has not happened yet is not an event.
  const ends = (win ? inWindow(prepaidEnds(ix, rules), from, to, (b) => b.date) : prepaidEnds(ix, rules).get(month) || []).filter((b) => b.date < today);
  for (const b of ends) {
    if (isTest(b.customer, null, rules) || isInstitutional(b.customer, rules)) continue;
    const back = returnAfter(ix, b.customer_id, b.date, rules);
    const row = { segment: SEGMENT_LABEL.prepaid, booking_id: b.id, customer_id: b.customer_id, customer: b.customer, cancelled_on: b.date, service_date: b.date, frequency: b.frequency, reason: 'Prepaid plan ended, not renewed', cancelled_by: 'Plan ended', last_cleaner: lastCleaner(ix, b), over_cancel: false };
    let outcome = null;
    if (back.kind === 'temporary') {
      outcome = `Excluded: temporary churn, renewed after ${back.days} days`;
      if (!counted.has(b.customer_id)) temporary.set(b.customer_id, 'prepaid');
    } else if (back.kind === 'continued') continue;
    else if (counted.has(b.customer_id)) outcome = 'Excluded: second event this month';
    if (!outcome) mark(b, b.date);
    events.push({ ...row, completion: true, counted: !outcome, outcome: outcome || `Counted as churn (prepaid plan ended${provisional.has(b.customer_id) ? `, inside the ${rules.temporaryReturnDays}-day return window` : ''})` });
  }
  for (const id of counted) temporary.delete(id);

  // Base: clients with a recurring visit in the month that was still on the books on the 1st.
  const base = new Map();
  // For a custom range: a recurring visit booked in the 31 days from its start date.
  for (const b of win ? inWindow(ix.byMonth, from, addDays(from, 30), (x) => x.date) : ix.byMonth.get(month) || []) {
    if (!isRecurring(b.frequency, rules)) continue;
    if (b.cancellation && dayOf(b.cancellation.at) < start) continue;
    const had = base.get(b.customer_id);
    // On both a prepaid and a pay-as-you-go plan in the period: kept under the first, and flagged.
    if (had) { if (churnSegment(b.frequency) !== had.seg) had.mixed = true; continue; }
    if (isTest(b.customer, null, rules) || isInstitutional(b.customer, rules)) continue;
    base.set(b.customer_id, { customer_id: b.customer_id, customer: b.customer, frequency: b.frequency, first_visit: b.date, churned: false, seg: churnSegment(b.frequency), segment: SEGMENT_LABEL[churnSegment(b.frequency)], mixed: false });
  }
  for (const id of counted) if (base.has(id)) base.get(id).churned = true;

  const num = counted.size;
  const den = base.size;
  const value = den ? (num / den) * 100 : null;
  // The same events and base, split by plan type. A churned client is counted under the plan
  // of the booking that ended; the base under the client's first recurring visit in the period.
  const segments = {};
  for (const key of ['prepaid', 'payg']) {
    segments[key] = {
      den: [...base.values()].filter((x) => x.seg === key).length,
      permanent: [...counted].filter((id) => segOf.get(id) === key).length,
      provisional: [...provisional].filter((id) => segOf.get(id) === key).length,
      temporary: [...temporary.values()].filter((x) => x === key).length,
    };
  }
  const unclear = {
    mixed: [...base.values()].filter((x) => x.mixed).length,
    off_base: [...counted].filter((id) => !base.has(id)).length,
    moved: [...counted].filter((id) => base.has(id) && base.get(id).seg !== segOf.get(id)).length,
  };
  return { month, state: den ? 'ok' : 'no_data', value, num, den, segments, unclear, plan_ends: events.filter((e) => e.completion && e.counted).length, single_visit: events.filter((e) => e.counted && e.scope === SCOPE_LABEL.single).length, provisional: provisional.size, temporary: temporary.size, band: value == null ? null : churnBand(value, rules), events, base: [...base.values()], pending: events.filter((e) => e.outcome.startsWith('Pending')).length, over_cancel: events.filter((e) => e.over_cancel && !e.outcome.includes('test')) };
}

// ---------- 3. Service fulfilment ----------
/**
 * Bookings completed ÷ bookings scheduled, for visits dated from..to (inclusive) that have
 * already happened. A visit we completed is fulfilled even if we arrived late (late arrivals
 * are counted separately). Anything not completed is not fulfilled, whoever caused it; the
 * breakdown says whether it was ours (controllable), the client's, or unclear.
 */
export function fulfilmentRange(ix, from, to, today, rules = KPI_RULES) {
  const rows = [];
  for (const m of monthsBetween(monthOf(from), monthOf(to))) {
    for (const b of ix.byMonth.get(m) || []) {
      if (b.date < from || b.date > to || b.date >= today) continue;
      if (isTest(b.customer, b.cancellation?.reason, rules)) continue;
      let kind;
      let label;
      let late = null;
      if (b.cancellation) {
        const c = cancellationCause(b.cancellation, rules);
        kind = c.cause;
        label = c.label;
      } else if (!b.completed) {
        kind = 'company';
        label = 'Not completed (no check-in)';
      } else {
        kind = 'done';
        late = b.checkin_at ? Math.round((ms(b.checkin_at) - ms(b.start)) / 60_000) : null;
        label = late != null && late > rules.lateMinutes ? `Completed, arrived late (over ${rules.lateMinutes} min)` : 'Completed as scheduled';
      }
      const isLate = kind === 'done' && late != null && late > rules.lateMinutes;
      const cutoff = ms(b.start) - rules.snapshotHours * 3_600_000;
      // No creation time from the source: assume it was on the books.
      const onBooks = (!b.created_at || ms(b.created_at) <= cutoff) && (!b.cancellation || ms(b.cancellation.at) > cutoff);
      rows.push({ booking_id: b.id, customer: b.customer, date: b.date, start: b.start.slice(11, 16), cleaner: b.cleaner || '', frequency: b.frequency, result: label, kind, late: isLate, group: FULFILMENT_GROUPS[kind], minutes_late: late, cancel_reason: b.cancellation?.reason || '', cancelled_by: b.cancellation ? (b.cancellation.by === 'staff' ? 'Staff' : 'Client') : '', on_books_48h: onBooks, issue: kind !== 'done' || isLate, counted: true });
    }
  }
  // Headline: of the bookings on the books 48 hours ahead (the ones we could have fulfilled),
  // how many we completed. "All scheduled" also counts bookings cancelled earlier than that.
  const split = (list) => {
    const count = (k) => list.filter((r) => r.kind === k).length;
    const done = count('done');
    return { num: done, den: list.length, value: list.length ? (done / list.length) * 100 : null, company: count('company'), client: count('client'), unclassified: count('unclassified') };
  };
  const snapRows = rows.filter((r) => r.on_books_48h);
  const snap = split(snapRows);
  const reasons = new Map();
  for (const r of snapRows) if (r.kind !== 'done') reasons.set(`${r.kind}|${r.result}`, (reasons.get(`${r.kind}|${r.result}`) || 0) + 1);
  const order = { company: 0, client: 1, unclassified: 2 };
  const misses = [...reasons].map(([k, n]) => ({ kind: k.split('|')[0], group: FULFILMENT_GROUPS[k.split('|')[0]], label: k.split('|')[1], n })).sort((a, b) => order[a.kind] - order[b.kind] || b.n - a.n);
  return { from, to, state: snap.den ? 'ok' : 'no_data', ...snap, misses, late: rows.filter((r) => r.late).length, all: split(rows), added_late: rows.filter((r) => !r.on_books_48h && r.kind === 'done').length, rows };
}
export function fulfilmentMonth(ix, month, today, rules = KPI_RULES) {
  const r = fulfilmentRange(ix, monthStart(month), monthEnd(month), today, rules);
  // Weeks (Monday to Sunday) that overlap the month, each clipped to the month.
  const weeks = [];
  let d = monthStart(month);
  while (d <= monthEnd(month)) {
    const dow = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
    const end = addDays(d, 6 - dow) > monthEnd(month) ? monthEnd(month) : addDays(d, 6 - dow);
    const w = fulfilmentRange(ix, d, end, today, rules);
    weeks.push({ from: d, to: end, value: w.value, num: w.num, den: w.den });
    d = addDays(end, 1);
  }
  return { ...r, month, weeks };
}

// ---------- 4. Complaints ----------
/**
 * Complaints ÷ completed visits × 100 for one month. A complaint is a Kustomer complaint
 * object or a Launch27 bottom rating; the same visit (or the same client within dedupeDays)
 * is counted once.
 */
export function complaintsMonth(ix, month, today, rules = KPI_RULES, win = null) {
  const from = win?.from || monthStart(month);
  const to = win?.to || monthEnd(month);
  // When the source only covers some periods, a month outside them is "No data", not zero complaints.
  const cover = ix.ds.complaintCoverage;
  if (cover) {
    const end = to < today ? to : addDays(today, -1);
    if (!cover.some((w) => w.from <= from && w.to >= end)) return { month, state: 'no_data', value: null, num: 0, den: 0, saved: { measurable: false, measurable_on: null, saved: null, total: 0, pct: null }, rows: [], uncovered: true };
  }
  const rows = [];
  const add = (r) => rows.push({ ...r, sources: [r.source], counted: true, outcome: 'Counted' });
  const same = (r, customerId, bookingId, date) => r.customer_id === customerId && ((bookingId && r.booking_id === bookingId) || ((!bookingId || !r.booking_id) && daysApart(r.date, date) <= rules.dedupeDays));
  for (const c of [...inWindow(ix.complaintsByMonth, from, to, (x) => x.date)].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (isTest(c.customer, c.summary, rules)) continue;
    const dup = rows.find((r) => same(r, c.customer_id, c.booking_id, c.date));
    if (dup) rows.push({ id: `k${c.id}`, customer_id: c.customer_id, customer: c.customer, date: c.date, booking_id: c.booking_id || null, source: 'Kustomer', sources: ['Kustomer'], detail: c.summary || '', counted: false, outcome: 'Duplicate of another complaint for this visit' });
    else add({ id: `k${c.id}`, customer_id: c.customer_id, customer: c.customer, date: c.date, booking_id: c.booking_id || null, source: 'Kustomer', detail: c.summary || '' });
  }
  for (const b of inWindow(ix.badRatingsByMonth, from, to, (x) => x.rated_at)) {
    if (isTest(b.customer, null, rules)) continue;
    const row = { id: `r${b.id}`, customer_id: b.customer_id, customer: b.customer, date: b.rated_at, booking_id: b.id, source: 'Launch27 rating', detail: b.rating_comment || 'Bottom rating' };
    const here = rows.find((r) => r.counted && same(r, b.customer_id, b.id, b.rated_at));
    // The matching Kustomer complaint may sit in a neighbouring month: still one complaint.
    const elsewhere = !here && (ix.complaintsByCustomer.get(b.customer_id) || []).some((c) => (c.date < from || c.date > to) && ((c.booking_id && c.booking_id === b.id) || (!c.booking_id && daysApart(c.date, b.rated_at) <= rules.dedupeDays)));
    if (here) {
      here.sources.push('Launch27 rating');
      rows.push({ ...row, sources: [row.source], counted: false, outcome: 'Same visit as a Kustomer complaint (counted once)' });
    } else if (elsewhere) rows.push({ ...row, sources: [row.source], counted: false, outcome: 'Counted in the month of its Kustomer complaint' });
    else add(row);
  }
  const visits = inWindow(ix.byMonth, from, to, (x) => x.date).filter((b) => b.completed && !b.cancellation && !isTest(b.customer, null, rules)).length;
  const counted = rows.filter((r) => r.counted);
  // Saved: still booking savedDays after the complaint. Only measurable once that time has passed.
  const measurableOn = addDays(to, rules.savedDays);
  const measurable = today >= measurableOn && counted.length > 0;
  for (const r of counted) {
    const after = addDays(r.date, rules.savedDays);
    r.saved = today >= after ? (ix.byCustomer.get(r.customer_id) || []).some((b) => !b.cancellation && b.date >= after) : null;
  }
  const saved = counted.filter((r) => r.saved).length;
  return { month, state: visits ? 'ok' : 'no_data', value: visits ? (counted.length / visits) * 100 : null, num: counted.length, den: visits, saved: { measurable, measurable_on: measurableOn, saved: measurable ? saved : null, total: counted.length, pct: measurable ? (saved / counted.length) * 100 : null }, rows };
}

// ---------- 5. Google reviews ----------
export function reviewsMonth(ix, month, rules = KPI_RULES, win = null) {
  const from = win?.from || monthStart(month);
  const to = win?.to || monthEnd(month);
  const visits = inWindow(ix.byMonth, from, to, (x) => x.date).filter((b) => b.completed && !b.cancellation && !isTest(b.customer, null, rules)).length;
  const manual = win ? null : ix.ds.manualReviews?.[month];
  if (manual) {
    return { month, state: 'ok', manual: true, value: manual.new_reviews, num: manual.new_reviews, rated: manual.new_reviews, avg: manual.avg_rating, rating_sum: manual.avg_rating * manual.new_reviews, alltime_avg: manual.alltime_avg, alltime_count: manual.alltime_count, visits, per100: visits ? (manual.new_reviews / visits) * 100 : null, rows: [] };
  }
  const base = ix.ds.reviewBaseline;
  if (!ix.ds.reviews || !base) return { month, state: 'no_data', value: null, num: 0, rows: [], visits };
  // An export only knows reviews up to its last date: later months are No data, never zero.
  const exp = ix.ds.reviewsExport || null;
  if (exp && from > exp.reviews_to) return { month, state: 'no_data', value: null, num: 0, rows: [], visits, after_export: true };
  const rows = inWindow(ix.reviewsByMonth, from, to, (x) => x.date);
  // A review can be counted without its stars (Google Places public data: the count is exact,
  // the stars are known only for the few reviews Google shows). Averages use the known stars.
  const rated = rows.filter((r) => r.rating != null);
  const sum = rated.reduce((t, r) => t + r.rating, 0);
  let allCount = base.count;
  let allRated = base.avg != null ? (base.rated ?? base.count) : 0;
  let allSum = base.avg != null ? allRated * base.avg : 0;
  for (const [m, list] of ix.reviewsByMonth) if (m <= monthOf(to)) for (const r of list) if (r.date <= to) (allCount += 1), r.rating != null && ((allRated += 1), (allSum += r.rating));
  return { month, state: 'ok', manual: false, value: rows.length, num: rows.length, rated: rated.length, avg: rated.length ? sum / rated.length : null, rating_sum: sum, alltime_avg: allRated ? allSum / allRated : null, alltime_count: allCount, visits, per100: visits ? (rows.length / visits) * 100 : null, rows, export: exp, partial: !!exp && to > exp.reviews_to };
}

/** OCR against its target range (lower is better): on track, within 5% of missing it, or more than 5% off. */
export function ocrStatus(pct, rules = KPI_RULES) {
  const max = rules.ocrTarget[1];
  if (pct <= max) return { label: 'On track', tone: 'good' };
  if (pct <= max * (1 + rules.ragTolerance)) return { label: 'Warning', tone: 'warning' };
  return { label: 'Off track', tone: 'critical' };
}

/** Fulfilment against its target (higher is better), same 5% rule as OCR. */
export function fulfilmentStatus(pct, rules = KPI_RULES) {
  const min = rules.fulfilmentTarget;
  if (pct >= min) return { label: 'On track', tone: 'good' };
  if (pct >= min * (1 - rules.ragTolerance)) return { label: 'Warning', tone: 'warning' };
  return { label: 'Off track', tone: 'critical' };
}

// ---------- scorecard ----------
const FORMULAS = (rules) => ({
  ocr: `Operational delivery cost ÷ revenue for the month, from QuickBooks Online.\nIncluded: ${Object.values(rules.ocrIncluded).join('; ')}.\nExcluded: ${Object.values(rules.ocrExcluded).join('; ')}.\nSyft's reported figure is shown beside it; ⚠ when the two differ by more than ${rules.ocrFlagPp.toFixed(1)} percentage points. Provisional until the ${rules.closeDay}th of the following month, then Final. Change is in percentage points.\nStatus against the ${rules.ocrTarget[0]}–${rules.ocrTarget[1]}% target (lower is better): On track at or under ${rules.ocrTarget[1]}%, Warning within 5% above it, Off track beyond that.`,
  churn: `Permanent churn events in the calendar month ÷ active recurring clients at the start of the month.\nRecurring: frequency contains weekly, biweekly, triweekly, monthly or prepaid (not one-time).\nLeft out of both sides: institutional clients and test entries.\nPermanent churn: the client cancels and has no recurring visit in the ${rules.temporaryReturnDays} days after. A cancellation inside the last ${rules.temporaryReturnDays} days counts now and is marked provisional; it drops out if the client returns.\nTemporary churn (shown, not in the rate): the client cancelled this and all future recurring bookings in Launch27, then came back within ${rules.temporaryReturnDays} days. A cancellation of one booking followed by a return is a skipped or moved visit and is neither. Where Launch27 gives no cancellation type, more than ${rules.temporaryGapDays} days between cleans stands in for it.\nPrepaid plan that runs out with no renewal: churn dated the last prepaid visit, with the same return test.\nNot counted as churn: transfers to LuxoClean and admin errors.\nCancellations with a temporary reason (travel, hold/pause, renovation, Airbnb, postpartum) are not counted while still inside the ${rules.temporaryReturnDays}-day window, so recent months can rise. One event per client per month, dated by the cancellation date.\nPrepaid = the Launch27 frequency name contains 'prepaid'; everything else recurring is pay-as-you-go. A churned client is counted under the plan of the booking that ended; the starting count under the client's first recurring visit in the period.\nBands: ≤7% Excellent · 7–10% Healthy · 10–12% Elevated · over 12% High. Target: under ${rules.churnTarget}%. Last 12 months is the 12 months pooled (events ÷ the sum of monthly bases).\nThe CS dashboard uses a 30-day trailing window, so expect a 1–3 event difference.`,
  fulfilment: `Bookings completed ÷ bookings that were on the books ${rules.snapshotHours} hours before the visit: the ones we could have fulfilled.\nThe all-scheduled figure is the same ratio over every booking for the period, including those cancelled earlier than ${rules.snapshotHours} hours ahead. Bookings made inside ${rules.snapshotHours} hours are listed separately.\nIf we arrived and did the clean, it is fulfilled, even when late: arrivals more than ${rules.lateMinutes} minutes after the scheduled start (Launch27 check-in) are counted separately as late.\nStatus against the ${rules.fulfilmentTarget}% target: On track at or above it, Warning within 5% below, Off track beyond that.\nAnything not completed is not fulfilled, whoever caused it. The breakdown splits it into ours (cleaner no-show, cleaner cancelled, unable to staff, we rescheduled, no check-in), client-related (the client cancelled, or staff entered a client reason) and unclear (a staff cancellation with no recognizable reason).`,
  complaints: `Complaints ÷ completed visits × 100.\nA complaint is a Kustomer complaint object or a Launch27 bottom ("bad") rating. The same visit, or the same client within ${rules.dedupeDays} days, counts once.\nSaved: the client still has a booking ${rules.savedDays}+ days after the complaint; shown once ${rules.savedDays} days have passed.`,
  reviews: 'New Google reviews in the month, with the average rating for the month and all time, and reviews per 100 completed visits (Launch27).',
  billing: 'Not built yet.',
});
const SEGMENT_FORMULA = (rules, label, rule) => `${label} only: permanent churn events ÷ ${label.toLowerCase()} clients at the start of the period.\n${rule}\nSame rules as Recurring client churn (open its "i" for the full list): permanent = no recurring visit within ${rules.temporaryReturnDays} days of cancelling; temporary churn and skipped visits are not in the rate.\nA churned client is counted under the plan of the booking that ended; the starting count under the client's first recurring visit in the period.`;
const SOURCES_FOR = { ocr: ['qbo', 'syft'], churn: ['launch27'], churn_prepaid: ['launch27'], churn_payg: ['launch27'], fulfilment: ['launch27'], complaints: ['kustomer', 'launch27'], reviews: ['google', 'launch27'] };
const UNIT = { ocr: 'pct', churn: 'pct', churn_prepaid: 'pct', churn_payg: 'pct', fulfilment: 'pct', complaints: 'per100', reviews: 'count' };
const LOWER_IS_BETTER = { ocr: true, churn: true, churn_prepaid: true, churn_payg: true, fulfilment: false, complaints: true, reviews: false };

const monthly = (ix, kpi, month, today, rules) =>
  kpi === 'ocr' ? ocrMonth(ix, month, today, rules) : isChurn(kpi) ? churnFor(kpi, churnMonth(ix, month, today, rules), rules) : kpi === 'fulfilment' ? fulfilmentMonth(ix, month, today, rules) : kpi === 'complaints' ? complaintsMonth(ix, month, today, rules) : reviewsMonth(ix, month, rules);

/** One KPI over one month or pooled over several (trailing 12): sums of numerators ÷ sums of denominators. */
function measure(ix, kpi, months, today, rules) {
  const parts = months.map((m) => monthly(ix, kpi, m, today, rules));
  if (parts.length === 1) return { ...parts[0], parts, missing: 0 };
  const ok = parts.filter((p) => p.state === 'ok');
  const num = ok.reduce((t, p) => t + p.num, 0);
  const den = ok.reduce((t, p) => t + (p.den || 0), 0);
  // OCR from Syft reports that give no income figure cannot be pooled by dollars: average the months instead.
  const unweighted = kpi === 'ocr' && ok.some((p) => !p.den);
  const value = !ok.length ? null : kpi === 'reviews' ? num : unweighted ? ok.reduce((t, p) => t + p.value, 0) / ok.length : den ? (num / den) * 100 : null;
  return { state: value == null ? 'no_data' : 'ok', value, num, den, parts, missing: parts.length - ok.length };
}

/**
 * The scorecard for one brand.
 * mode 'month': the selected month vs the month before. mode 't12': the 12 months ending at
 * the selected month, pooled, vs the 12 before.
 * A KPI whose source is missing has no value (state 'no_data'). A source that has not refreshed
 * lately keeps its figures and is marked `stale`: the page says so once, at the top.
 */
/** One KPI over exact dates (a custom range). OCR is reported by month only. */
function ranged(ix, kpi, w, today, rules) {
  const p =
    kpi === 'ocr' ? { state: 'no_data', value: null, num: 0, den: 0, monthly_only: true }
    : isChurn(kpi) ? churnFor(kpi, churnMonth(ix, monthOf(w.from), today, rules, w), rules)
    : kpi === 'fulfilment' ? fulfilmentRange(ix, w.from, w.to, today, rules)
    : kpi === 'complaints' ? complaintsMonth(ix, monthOf(w.from), today, rules, w)
    : reviewsMonth(ix, monthOf(w.from), rules, w);
  return { ...p, parts: [p], missing: 0 };
}

export function scorecard(ix, { brand, month, mode = 'month', range = null, now, today, rules = KPI_RULES }) {
  // mode 'range': exact dates (range.from..range.to), compared with the same number of days before.
  const isRange = mode === 'range' && !!range;
  if (isRange) month = monthOf(range.to);
  const days = isRange ? Math.round((ms(range.to) - ms(range.from)) / DAY) + 1 : 0;
  const prevRange = isRange ? { from: addDays(range.from, -days), to: addDays(range.from, -1) } : null;
  const inProgress = !isRange && mode !== 't12' && month === monthOf(today);
  const span = mode === 't12' ? 12 : 1;
  const months = monthsBetween(addMonths(month, 1 - span), month).filter((m) => m >= rules.firstMonth);
  const prevMonths = monthsBetween(addMonths(month, 1 - 2 * span), addMonths(month, -span)).filter((m) => m >= rules.firstMonth);
  const period = isRange ? (range.from === range.to ? dayLabel(range.from) : `${dayLabel(range.from)} – ${dayLabel(range.to)}`) : span === 1 ? `${monthLabel(month)}${inProgress ? ' to date' : ''}` : `${monthLabel(months[0])} – ${monthLabel(month)}`;
  const formulas = { ...FORMULAS(rules), churn_prepaid: SEGMENT_FORMULA(rules, 'Prepaid', "Prepaid = the Launch27 frequency name contains 'prepaid'. A plan that runs out with no renewal counts, dated the last prepaid visit."), churn_payg: SEGMENT_FORMULA(rules, 'Pay-as-you-go', "Pay-as-you-go = every recurring frequency that is not prepaid.") };
  const tiles = brand.kpis.map((kpi) => {
    const tile = { kpi, label: KPI_LABELS[kpi], period, formula: formulas[kpi], unit: UNIT[kpi] || null, value: null, delta: null, status: null, badges: [], details: [], sources: [], refreshed_at: null, target: null, last12: null };
    if (kpi === 'billing') return { ...tile, state: 'disabled', note: 'Coming later' };
    const src = sourcesFor(ix, SOURCES_FOR[kpi], now, rules);
    tile.sources = src.list;
    tile.refreshed_at = src.list.map((s) => s.refreshed_at).filter(Boolean).sort()[0] || null;
    // OCR can stand on QBO alone (Syft is the cross-check); everything else needs all its sources.
    // OCR needs QuickBooks or, failing that, the Syft report; everything else needs all its sources.
    const ocrBlock = () => (sourcesFor(ix, ['qbo'], now, rules).state === 'ok' ? 'ok' : sourcesFor(ix, ['syft'], now, rules).state);
    const blocking = kpi === 'ocr' ? ocrBlock() : src.state;
    if (blocking === 'no_data') return { ...tile, state: blocking, note: src.list.filter((s) => s.state === 'missing').map((s) => `${s.label}: ${s.note || 'not connected'}`).join(' · ') };
    if (blocking === 'stale') tile.stale = true;
    const cur = isRange ? ranged(ix, kpi, range, today, rules) : measure(ix, kpi, months, today, rules);
    if (cur.state !== 'ok') return { ...tile, state: 'no_data', note: cur.monthly_only ? 'Reported by month only. Choose a month to see it.' : `No data for ${period}` };
    const prev = isRange ? (prevRange.from >= monthStart(rules.firstMonth) ? ranged(ix, kpi, prevRange, today, rules) : null) : prevMonths.length === span ? measure(ix, kpi, prevMonths, today, rules) : null;
    tile.state = 'ok';
    tile.value = round(cur.value, kpi === 'reviews' ? 0 : kpi === 'complaints' ? 2 : 1);
    if (prev?.state === 'ok') {
      const d = round(cur.value - prev.value, kpi === 'reviews' ? 0 : kpi === 'complaints' ? 2 : 1);
      tile.delta = { value: d, unit: UNIT[kpi] === 'pct' ? 'pp' : UNIT[kpi], better: d === 0 ? null : d < 0 === LOWER_IS_BETTER[kpi], versus: isRange ? `the ${days} day${days === 1 ? '' : 's'} before` : span === 1 ? monthLabel(prevMonths[0]) : 'the 12 months before' };
    }
    if (inProgress) tile.badges.push({ tone: 'neutral', text: 'Month in progress: figures to date' });
    if (cur.missing) tile.badges.push({ tone: 'warning', text: `${cur.missing} of ${months.length} months have no data` });
    tile.details.push({ label: kpi === 'ocr' ? 'Cost ÷ revenue' : isChurn(kpi) ? 'Events ÷ starting clients' : kpi === 'fulfilment' ? 'Completed ÷ scheduled' : kpi === 'complaints' ? 'Complaints ÷ visits' : 'New reviews', value: kpi === 'ocr' ? `$${Math.round(cur.num).toLocaleString('en-CA')} ÷ $${Math.round(cur.den).toLocaleString('en-CA')}` : kpi === 'reviews' ? String(cur.num) : `${cur.num.toLocaleString('en-CA')} ÷ ${cur.den.toLocaleString('en-CA')}` });
    const one = span === 1 ? cur : null;
    // Baseline: the same measure pooled over the 12 months ending at the selected month.
    const lastFull = inProgress || isRange ? addMonths(monthOf(today) < month ? monthOf(today) : month, month === monthOf(today) ? -1 : 0) : month;
    const base12 = span === 1 ? measure(ix, kpi, monthsBetween(addMonths(lastFull, -11), lastFull).filter((m) => m >= rules.firstMonth), today, rules) : null;
    const baseline = base12?.state === 'ok' ? base12.value : null;
    // The same two reference lines on every tile, in the same words: Target and Last 12 months.
    tile.target = kpi === 'ocr' ? `${rules.ocrTarget[0]}–${rules.ocrTarget[1]}%` : kpi === 'churn' ? `under ${rules.churnTarget}%` : kpi === 'fulfilment' ? `${rules.fulfilmentTarget}% or higher` : null;
    tile.last12 = baseline == null ? null : kpi === 'reviews' ? `${(baseline / 12).toFixed(0)} a month` : kpi === 'complaints' ? `${baseline.toFixed(2)} per 100 visits` : `${baseline.toFixed(1)}%`;
    if (kpi === 'ocr') {
      tile.status = ocrStatus(cur.value, rules);
      const fromSyft = cur.parts.filter((p) => p.state === 'ok' && p.basis === 'syft').length;
      if (fromSyft) {
        tile.badges.push({ tone: 'warning', text: `From the Syft report${fromSyft === cur.parts.length ? '' : ` for ${fromSyft} of ${cur.parts.length} months`}: QuickBooks is not connected, so there is no cross-check` });
        if (brand.syftScope) tile.badges.push({ tone: 'neutral', text: brand.syftScope });
        tile.details[0] = one ? { label: 'Total income (Syft report)', value: one.syft_income != null ? `$${Math.round(one.syft_income).toLocaleString('en-CA')}` : '—' } : { label: 'Months from the Syft report', value: `${fromSyft} of ${cur.parts.length}` };
      }
      if (one) {
        if (one.status === 'Provisional') tile.badges.push({ tone: 'warning', text: `Provisional until the ${rules.closeDay}th of ${monthLabel(addMonths(month, 1))}` });
        tile.details.push({ label: 'Books', value: one.status });
        tile.details.push({ label: 'Syft reported', value: one.syft == null ? 'Not received yet' : `${one.syft.toFixed(1)}%` });
        if (one.syft_file) tile.details.push({ label: 'Report', value: `${one.syft_file} · received ${dayOf(one.syft_received)}` });
        if (one.flagged) tile.badges.push({ tone: 'warning', text: `QBO and Syft differ by ${Math.abs(one.diff).toFixed(1)} pp` });
        else if (one.diff != null) tile.details.push({ label: 'QBO vs Syft', value: `${one.diff >= 0 ? '+' : '−'}${Math.abs(one.diff).toFixed(1)} pp` });
      } else {
        const flagged = cur.parts.filter((p) => p.flagged).length;
        if (flagged) tile.badges.push({ tone: 'warning', text: `${flagged} month${flagged === 1 ? '' : 's'} where QBO and Syft differ by over ${rules.ocrFlagPp.toFixed(1)} pp` });
      }
    }
    if (kpi in CHURN_SEGMENT) {
      const band = churnBand(cur.value, rules);
      if (isRange || inProgress) tile.badges.push({ tone: 'neutral', text: 'Monthly bands do not apply to a partial period' });
      else tile.status = { label: band.label, tone: band.tone };
      const sumP = (k) => cur.parts.reduce((t, p) => t + (p[k] || 0), 0);
      // A small starting count swings the rate: say how much one client is worth.
      if (cur.den < 100) tile.badges.push({ tone: 'neutral', text: `Small base: one client is ${(100 / cur.den).toFixed(1)} pp` });
      tile.details.push({ label: 'Temporary churn (back within 90 days)', value: `${sumP('temporary')} (not in the rate)` });
      tile.details.push({ label: `Provisional (inside the ${rules.temporaryReturnDays}-day window)`, value: `${sumP('provisional')} of ${cur.num}` });
      if (kpi === 'churn_prepaid') tile.details.push({ label: 'Plans ended, not renewed', value: `${sumP('plan_ends')} of ${cur.num}` });
      if (sumP('pending')) tile.details.push({ label: `Temporary reason, inside ${rules.temporaryReturnDays}-day window`, value: `${sumP('pending')} (not counted yet)` });
    }
    if (kpi === 'churn') {
      const band = churnBand(cur.value, rules);
      // The bands and target are monthly rates: they do not apply to a custom range or a month in progress.
      if (isRange || inProgress) tile.badges.push({ tone: 'neutral', text: 'Monthly bands and target do not apply to a partial period' });
      else tile.status = { label: band.label, tone: band.tone };
      const sumP = (pick) => cur.parts.reduce((t, p) => t + (pick(p) || 0), 0);
      const segRow = (key, label) => {
        const g = (k) => sumP((p) => (key ? p.segments[key][k] : p.segments.prepaid[k] + p.segments.payg[k]));
        const den = key ? g('den') : cur.den;
        return { key: key || 'all', label, den, temporary: g('temporary'), permanent: g('permanent'), provisional: g('provisional'), value: den ? round((g('permanent') / den) * 100) : null };
      };
      tile.segments = [segRow('prepaid', 'Prepaid'), segRow('payg', 'Pay-as-you-go'), segRow(null, 'All recurring')];
      const ends = sumP((p) => p.plan_ends);
      tile.details.push({ label: 'Prepaid plans ended, not renewed', value: ends ? `${ends} · without them ${(((cur.num - ends) / cur.den) * 100).toFixed(1)}%` : '0' });
      const faded = sumP((p) => p.single_visit);
      if (faded) tile.details.push({ label: 'Counted after a one-visit cancellation', value: `${faded} (no recurring visit since)` });
      const unclear = ['mixed', 'off_base', 'moved'].map((k) => sumP((p) => p.unclear[k]));
      tile.segment_notes = [
        unclear[0] ? `${unclear[0]} client${unclear[0] === 1 ? '' : 's'} on both a prepaid and a pay-as-you-go plan in the period (kept under their first visit's plan)` : null,
        unclear[2] ? `${unclear[2]} churned client${unclear[2] === 1 ? '' : 's'} whose ended booking was on a different plan from their first visit` : null,
        unclear[1] ? `${unclear[1]} churned client${unclear[1] === 1 ? '' : 's'} with no recurring visit in the starting count` : null,
      ].filter(Boolean);
      const flags = cur.parts.reduce((t, p) => t + p.over_cancel.length, 0);
      const pending = cur.parts.reduce((t, p) => t + p.pending, 0);
      if (pending) tile.details.push({ label: `Temporary, inside ${rules.temporaryReturnDays}-day window`, value: `${pending} (not counted yet)` });
      tile.details.push({ label: 'Admin over-cancellation flags', value: String(flags), drill: 'over_cancel' });
    }
    if (kpi === 'fulfilment') {
      tile.status = fulfilmentStatus(cur.value, rules);
      const misses = new Map();
      for (const p of cur.parts) for (const m of p.misses || []) misses.set(`${m.kind}|${m.label}`, { ...m, n: (misses.get(`${m.kind}|${m.label}`)?.n || 0) + m.n });
      tile.breakdown = [...misses.values()];
      const sum = (k) => cur.parts.reduce((t, p) => t + (p[k] || 0), 0);
      const all = (k) => cur.parts.reduce((t, p) => t + (p.all?.[k] || 0), 0);
      const share = (n) => `${n} · ${((n / cur.den) * 100).toFixed(1)}%`;
      tile.details[0] = { label: `Completed ÷ on the books ${rules.snapshotHours} h ahead`, value: `${cur.num.toLocaleString('en-CA')} ÷ ${cur.den.toLocaleString('en-CA')}` };
      tile.details.push({ label: 'Not fulfilled: ours (controllable)', value: share(sum('company')) });
      tile.details.push({ label: 'Not fulfilled: client-related', value: share(sum('client')) });
      tile.details.push({ label: 'Not fulfilled: unclear reason', value: share(sum('unclassified')) });
      tile.details.push({ label: 'All scheduled (incl. cancelled earlier)', value: all('den') ? `${((all('num') / all('den')) * 100).toFixed(1)}% · ${all('num').toLocaleString('en-CA')} ÷ ${all('den').toLocaleString('en-CA')}` : '—' });
      tile.details.push({ label: `Booked inside ${rules.snapshotHours} h and completed`, value: String(sum('added_late')) });
      tile.details.push({ label: `Completed but late (over ${rules.lateMinutes} min)`, value: String(sum('late')) });
      if (sum('unclassified')) tile.badges.push({ tone: 'warning', text: `${sum('unclassified')} staff cancellation${sum('unclassified') === 1 ? '' : 's'} with no clear reason` });
      if (one) tile.weeks = one.weeks;
    }
    if (kpi === 'complaints') {
      if (one) tile.details.push({ label: `Saved (${rules.savedDays}-day)`, value: one.saved.measurable ? `${Math.round(one.saved.pct)}% (${one.saved.saved} of ${one.saved.total})` : one.saved.total ? `Measurable from ${one.saved.measurable_on}` : 'No complaints' });
      else {
        const m = cur.parts.filter((p) => p.saved.measurable);
        const total = m.reduce((t, p) => t + p.saved.total, 0);
        tile.details.push({ label: `Saved (${rules.savedDays}-day)`, value: total ? `${Math.round((m.reduce((t, p) => t + p.saved.saved, 0) / total) * 100)}% over ${m.length} measurable months` : 'Not measurable yet' });
      }
    }
    if (kpi === 'reviews') {
      const sum = cur.parts.reduce((t, p) => t + (p.rating_sum || 0), 0);
      const rated = cur.parts.reduce((t, p) => t + (p.rated ?? p.num ?? 0), 0);
      const visits = cur.parts.reduce((t, p) => t + (p.visits || 0), 0);
      const last = cur.parts[cur.parts.length - 1];
      tile.details = [
        { label: 'Average rating', value: rated ? `${(sum / rated).toFixed(2)} ★${rated < cur.num ? ` (stars known for ${rated} of ${cur.num})` : ''}` : cur.num ? 'Stars not known yet' : '—' },
        { label: 'All-time average', value: last.alltime_avg != null ? `${last.alltime_avg.toFixed(2)} ★ (${last.alltime_count.toLocaleString('en-CA')} reviews)` : '—' },
        { label: 'Per 100 completed visits', value: visits ? (cur.num / visits * 100).toFixed(1) : '—' },
      ];
      const shown = cur.parts.flatMap((p) => p.rows || []);
      if (shown.length) {
        const n = starCounts(shown);
        const low = shown.filter((r) => r.rating != null && r.rating <= 3).length;
        const unanswered = shown.filter((r) => r.replied === false).length;
        tile.details.push({ label: 'Stars', value: [5, 4, 3, 2, 1].map((k) => `${k}★ ${n[k]}`).join(' · '), drill: 'reviews_stars' });
        tile.details.push({ label: 'Low-star reviews (1–3★)', value: String(low), drill: 'reviews_low' });
        if (shown.some((r) => r.replied != null)) tile.details.push({ label: 'Not replied to', value: String(unanswered), drill: 'reviews_unanswered' });
        if (shown.some((r) => r.comment)) tile.details.push({ label: 'Reviews naming a cleaner', value: String(reviewRows(shown.filter((r) => r.comment), ix.ds.bookings).filter((r) => r.cleaners).length), drill: 'reviews_cleaners' });
      }
      if (cur.num > rated && !cur.parts.some((p) => p.manual)) tile.badges.push({ tone: 'neutral', text: `Google public data: every new review is counted; stars are known for ${rated} of ${cur.num}` });
      if (cur.parts.some((p) => p.manual)) tile.badges.push({ tone: 'warning', text: 'Manual entry (Google API not connected)' });
      const exp = cur.parts.find((p) => p.export)?.export;
      if (exp) {
        tile.badges.push({ tone: 'warning', text: `From a Google export dated ${exp.exported_on}: not live. Reviews after ${exp.reviews_to} are not included` });
        if (cur.parts.some((p) => p.partial)) tile.badges.push({ tone: 'warning', text: `${monthLabel(monthOf(exp.reviews_to))} is a partial month` });
      }
    }
    return tile;
  });

  // 12-month trend per KPI, ending at the selected month. A month with no data is a gap, never a zero.
  const trendMonths = monthsBetween(addMonths(month, -11), month).filter((m) => m >= rules.firstMonth);
  const trends = {};
  for (const tile of tiles) {
    if (tile.state !== 'ok') continue;
    trends[tile.kpi] = trendMonths.map((m) => {
      const r = monthly(ix, tile.kpi, m, today, rules);
      return { month: m, value: r.state === 'ok' ? round(r.value, tile.kpi === 'complaints' ? 2 : 1) : null, num: r.num, den: r.den ?? null, tone: isChurn(tile.kpi) && r.band ? r.band.tone : null, flag: tile.kpi === 'ocr' ? (r.flagged ? 'QBO and Syft differ' : r.status === 'Provisional' ? 'Provisional' : null) : null };
    });
  }
  const references = { churn: { line: rules.churnTarget, label: `target ${rules.churnTarget}%` }, fulfilment: { line: rules.fulfilmentTarget, label: `target ${rules.fulfilmentTarget}%` }, ocr: { band: rules.ocrTarget, label: `target ${rules.ocrTarget[0]}–${rules.ocrTarget[1]}%` } };
  return { brand: { key: brand.key, name: brand.name, detail: brand.detail }, month, mode: isRange ? 'range' : mode, range: isRange ? range : null, period, tiles, trends, references };
}

// ---------- drill-down ----------
const col = (key, label, kind) => ({ key, label, kind });

/** The rows behind one tile, each with whether and why it was counted. */
export function drill(ix, { kpi, month, mode = 'month', range = null, today, rules = KPI_RULES }) {
  const isRange = mode === 'range' && !!range;
  if (isRange) month = monthOf(range.to);
  const span = mode === 't12' ? 12 : 1;
  const months = monthsBetween(addMonths(month, 1 - span), month).filter((m) => m >= rules.firstMonth);
  const baseKpi = kpi === 'over_cancel' ? 'churn' : String(kpi).startsWith('reviews') ? 'reviews' : kpi;
  const parts = isRange ? ranged(ix, baseKpi, range, today, rules).parts.map((p) => ({ ...p, month: p.month || month, lines: p.lines || [] })) : months.map((m) => monthly(ix, baseKpi, m, today, rules));
  // (a plan tile's parts are already narrowed to that plan's events and starting clients)
  const all = (pick) => parts.flatMap((p) => pick(p) || []);
  const period = isRange ? `${dayLabel(range.from)} – ${dayLabel(range.to)}` : span === 1 ? monthLabel(month) : `${monthLabel(months[0])} – ${monthLabel(month)}`;
  if (kpi === 'ocr') {
    const rows = all((p) => p.lines.map((l) => ({ month: p.month, account: l.account, group: l.group, amount: l.amount, counted: l.included, outcome: l.included ? 'Included in operational cost' : 'Excluded' })).concat(p.state === 'ok' ? [{ month: p.month, account: 'Revenue', group: 'Revenue', amount: p.revenue, counted: true, outcome: 'Denominator' }] : []));
    const compare = parts.map((p) => ({ month: p.month, qbo: p.basis === 'syft' ? null : round(p.value), syft: p.syft, diff: round(p.diff), status: p.status, flagged: p.flagged, income: p.syft_income, file: p.syft_file, received: p.syft_received ? dayOf(p.syft_received) : null }));
    const tabs = [{ key: 'lines', label: 'QuickBooks lines', columns: [col('month', 'Month'), col('account', 'Account'), col('group', 'Category'), col('amount', 'Amount', 'money'), col('outcome', 'Treatment')], rows }, { key: 'compare', label: 'QBO vs Syft', columns: [col('month', 'Month'), col('qbo', 'QBO %', 'pct'), col('syft', 'Syft %', 'pct'), col('diff', 'Difference (pp)', 'num'), col('status', 'Status'), col('income', 'Total income (Syft)', 'money'), col('file', 'Syft report'), col('received', 'Received')], rows: compare.map((c) => ({ ...c, counted: true, outcome: c.flagged ? '⚠ over 1.0 pp' : '' })) }];
    // With no QuickBooks lines to show, lead with the Syft figures.
    return { title: `${KPI_LABELS.ocr} · ${period}`, tabs: rows.length ? tabs : tabs.reverse() };
  }
  if (isChurn(kpi) || kpi === 'over_cancel') {
    const eventCols = [col('cancelled_on', 'Cancelled'), col('customer', 'Client'), col('outcome', 'Result'), col('segment', 'Plan'), col('scope', 'Cancelled'), col('reason', 'Reason'), col('frequency', 'Frequency'), col('cancelled_by', 'Cancelled by'), col('last_cleaner', 'Last cleaner')];
    const flags = { key: 'over_cancel', label: 'Admin over-cancellation flags', columns: eventCols, rows: all((p) => p.over_cancel) };
    if (kpi === 'over_cancel') return { title: `Admin over-cancellation flags · ${period}`, tabs: [flags] };
    return { title: `${KPI_LABELS[kpi]} · ${period}`, tabs: [{ key: 'events', label: 'Cancellations', columns: eventCols, rows: all((p) => p.events) }, { key: 'base', label: 'Recurring base', columns: [col('month', 'Month'), col('customer', 'Client'), col('segment', 'Plan'), col('frequency', 'Frequency'), col('first_visit', 'First visit in month'), col('outcome', 'Result')], rows: all((p) => p.base.map((b) => ({ ...b, month: p.month, counted: true, outcome: `${b.churned ? 'Churned this month' : 'Active'}${b.mixed ? ' · on both plans' : ''}` }))) }, flags] };
  }
  if (kpi === 'fulfilment') {
    return { title: `${KPI_LABELS.fulfilment} · ${period}`, tabs: [{ key: 'bookings', label: 'Bookings', columns: [col('date', 'Date'), col('start', 'Start'), col('customer', 'Client'), col('result', 'Result'), col('group', 'Whose'), col('cleaner', 'Cleaner'), col('minutes_late', 'Min late', 'num'), col('cancel_reason', 'Cancellation reason'), col('cancelled_by', 'Cancelled by'), col('books_label', 'On books 48 h ahead')], rows: all((p) => p.rows.map((r) => ({ ...r, outcome: r.result, books_label: r.on_books_48h ? 'Yes' : 'No' }))), defaultFilter: 'issues' }] };
  }
  if (kpi === 'complaints') {
    return { title: `${KPI_LABELS.complaints} · ${period}`, tabs: [{ key: 'complaints', label: 'Complaints', columns: [col('date', 'Date'), col('customer', 'Client'), col('source', 'Source'), col('detail', 'Detail'), col('booking_id', 'Booking'), col('saved_label', `Saved (${rules.savedDays}-day)`), col('outcome', 'Result')], rows: all((p) => p.rows.map((r) => ({ ...r, source: r.sources.join(' + '), saved_label: !r.counted ? '' : r.saved == null ? 'Too recent' : r.saved ? 'Yes' : 'No' }))) }] };
  }
  if (baseKpi === 'reviews') {
    // Newest first. Client and cleaner are suggestions from names (src/kpi/review-details.js).
    const reviews = all((p) => p.rows).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const rows = reviewRows(reviews, ix.ds.bookings);
    const link = (key, label, href) => ({ key, label, link: href });
    const text = (key, label) => ({ key, label, kind: 'text' });
    const cols = [col('date', 'Date'), col('stars', 'Stars'), col('reviewer', 'Reviewer'), text('comment', 'Comment'), link('client', 'Client (by name)', 'client_href'), col('cleaners', 'Cleaners mentioned')];
    if (rows.some((r) => r.replied)) cols.push(col('replied', 'Replied'), text('reply', 'Our reply'));
    if (rows.some((r) => r.link_href)) cols.push(link('link', 'Google', 'link_href'));
    const n = starCounts(reviews);
    const known = Object.values(n).reduce((t, x) => t + x, 0);
    const tabs = [
      { key: 'reviews_all', label: 'All reviews', columns: cols, rows },
      { key: 'reviews_low', label: 'Low stars (1–3★)', columns: cols, rows: rows.filter((r) => r.low) },
      ...(rows.some((r) => r.replied) ? [{ key: 'reviews_unanswered', label: 'Not replied to', columns: cols, rows: rows.filter((r) => r.unanswered).reverse() }] : []),
      { key: 'reviews_cleaners', label: 'Cleaners mentioned', columns: [col('cleaners', 'Cleaner'), col('date', 'Date'), col('stars', 'Stars'), col('reviewer', 'Reviewer'), text('comment', 'Comment'), link('client', 'Client (by name)', 'client_href')], rows: rows.filter((r) => r.cleaners) },
      { key: 'reviews_stars', label: 'Stars', columns: [col('stars', 'Stars'), col('count', 'Reviews', 'num'), col('share', 'Share', 'pct')], rows: [5, 4, 3, 2, 1].map((k) => ({ stars: `${'★'.repeat(k)}${'☆'.repeat(5 - k)}`, count: n[k], share: known ? (n[k] / known) * 100 : null, counted: true, outcome: '' })).concat(reviews.length > known ? [{ stars: 'Stars not shown by Google', count: reviews.length - known, share: null, counted: true, outcome: '' }] : []) },
    ];
    // A tile detail opens the drill on its own tab.
    const first = tabs.findIndex((t) => t.key === kpi);
    if (first > 0) tabs.unshift(tabs.splice(first, 1)[0]);
    return { title: `${KPI_LABELS.reviews} · ${period}`, tabs };
  }
  return null;
}
