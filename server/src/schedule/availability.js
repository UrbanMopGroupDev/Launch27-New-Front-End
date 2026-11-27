// Changing a cleaner's availability from the portal (docs/availability.md).
// Launch27 keeps availability as weekly hours plus one-off rows by date ({ date, dayoff } or
// { date, start_time, end_time }); its own "Specific date" screen POSTs a list of those rows, each
// replacing that date's change. There is no delete: "back to usual hours" saves the date with the
// weekly hours. The weekly hours themselves are changed in Launch27.
// Ported from the Commercial portal's release (Bookingkoala-Frontend PR 63); Launch27 only.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_DAYS = 62;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekdayOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * The changes asked for, checked: { date, dayoff: true } (a day off), { date, start_time, end_time }
 * (hours that day) or { date, usual: true } (back to the usual hours); today to a year ahead, each date once.
 */
export function checkChanges(changes, today) {
  if (!Array.isArray(changes) || !changes.length) throw bad('Say which dates to change.');
  if (changes.length > MAX_DAYS) throw bad(`At most ${MAX_DAYS} dates at a time.`);
  const seen = new Set();
  const last = addDays(today, 366);
  return changes.map((c) => {
    const date = String(c?.date || '');
    if (!DATE.test(date)) throw bad('Each change needs a date.');
    if (date < today) throw bad(`${date} is in the past: only today and later can be changed.`);
    if (date > last) throw bad(`${date} is more than a year ahead.`);
    if (seen.has(date)) throw bad(`${date} is in the list twice.`);
    seen.add(date);
    if (c.usual) return { date, usual: true };
    if (c.dayoff) return { date, dayoff: true };
    const start = String(c.start_time || '');
    const end = String(c.end_time || '');
    if (!TIME.test(start) || !TIME.test(end)) throw bad(`Give the start and end time for ${date}.`);
    if (toMin(end) <= toMin(start)) throw bad(`On ${date} the end must be after the start.`);
    return { date, start_time: start, end_time: end };
  });
}

/** Dates from..to as a list (a date range for time off), checked. */
export function dateRange(from, to) {
  if (!DATE.test(String(from)) || !DATE.test(String(to))) throw bad('Give the first and last day.');
  if (to < from) throw bad('The last day must be on or after the first.');
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > MAX_DAYS) throw bad(`At most ${MAX_DAYS} days at a time.`);
  }
  return out;
}

/**
 * What Launch27 is sent: "back to the usual hours" becomes the weekday's weekly hours that date (or a
 * day off when the cleaner doesn't usually work that day). A weekday with split hours (8–12 and 1–5)
 * can't be sent as one row without losing the break, so that is refused: change it in Launch27.
 * weekly: [{ weekday, dayoff, start_time, end_time }].
 */
export function toRows(changes, weekly) {
  return changes.map((c) => {
    if (!c.usual) return c.dayoff ? { date: c.date, dayoff: true } : { date: c.date, start_time: c.start_time, end_time: c.end_time };
    const open = weekly.filter((r) => Number(r.weekday) === weekdayOf(c.date) && !r.dayoff && r.start_time && r.end_time);
    if (open.length > 1) throw bad(`Their usual hours on ${c.date} are split into ${open.length} blocks: put that date back in Launch27 (Specific date).`, 409);
    return open[0] ? { date: c.date, start_time: open[0].start_time, end_time: open[0].end_time } : { date: c.date, dayoff: true };
  });
}

/**
 * Visits the change leaves outside the cleaner's hours: on a day off, every visit that day; on new
 * hours, the visits that start before or end after them. days: availabilityDays rows.
 */
export function visitsAffected(rows, days) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out = [];
  for (const r of rows) {
    const d = byDate.get(r.date);
    if (!d) continue;
    for (const v of d.visits || []) {
      const ok = !r.dayoff && v.start >= toMin(r.start_time) && v.start + v.duration <= toMin(r.end_time);
      if (!ok) out.push({ date: r.date, time: v.time, end: v.end, customer: v.customer, booking_id: v.id ?? null });
    }
  }
  return out;
}

/** The portal's history of availability changes it made. */
export function createAvailabilityHistory({ db }) {
  async function record(entries) {
    for (const e of entries) {
      await db.query(
        `INSERT INTO availability_changes (cleaner_id, cleaner_name, date, before, after, outcome, error, note, source, by_id, by_name)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
        [e.cleaner_id, e.cleaner_name || null, e.date, e.before ? JSON.stringify(e.before) : null, JSON.stringify(e.after), e.outcome, e.error || null, e.note || null, e.source || 'calendar', e.by_id ?? null, e.by_name || null]);
    }
  }
  async function list(cleanerId, limit = 100) {
    return (await db.query('SELECT * FROM availability_changes WHERE cleaner_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [Number(cleanerId), Math.min(500, Number(limit) || 100)])).rows
      .map((r) => ({ id: Number(r.id), date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10), before: r.before, after: r.after, outcome: r.outcome, error: r.error, note: r.note, source: r.source, by_name: r.by_name, at: r.at }));
  }
  return { record, list };
}

/**
 * The usual weekly hours asked for, checked: one entry per weekday (0 Sunday … 6 Saturday), each a
 * day off or one or more blocks of hours ({ weekday, dayoff } or { weekday, blocks: [{ start_time,
 * end_time }] }). Blocks may not overlap. Returns Launch27-style weekly rows, sorted.
 */
export function checkWeekly(week) {
  if (!Array.isArray(week) || week.length !== 7) throw bad('Give the hours for all seven days.');
  const seen = new Set();
  const rows = [];
  for (const d of week) {
    const wd = Number(d?.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6 || seen.has(wd)) throw bad('Each weekday once, 0 (Sunday) to 6 (Saturday).');
    seen.add(wd);
    const blocks = Array.isArray(d.blocks) ? d.blocks : [];
    if (d.dayoff || !blocks.length) {
      rows.push({ weekday: wd, dayoff: true, start_time: null, end_time: null });
      continue;
    }
    const list = blocks.map((b) => {
      const a = String(b?.start_time || '');
      const z = String(b?.end_time || '');
      if (!TIME.test(a) || !TIME.test(z)) throw bad(`Give the start and end time for ${DAYNAMES[wd]}.`);
      if (toMin(z) <= toMin(a)) throw bad(`On ${DAYNAMES[wd]} the end must be after the start.`);
      return { start_time: a, end_time: z };
    }).sort((x, y) => toMin(x.start_time) - toMin(y.start_time));
    for (let i = 1; i < list.length; i++) if (toMin(list[i].start_time) < toMin(list[i - 1].end_time)) throw bad(`On ${DAYNAMES[wd]} two blocks overlap.`);
    for (const b of list) rows.push({ weekday: wd, dayoff: false, ...b });
  }
  return rows.sort((x, y) => x.weekday - y.weekday || String(x.start_time).localeCompare(String(y.start_time)));
}
const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The Launch27 requests for the two saves not yet recorded from Launch27's own screens. Each is kept
 * here, in one place, and is refused against the live Launch27 until VERIFIED says it matches a
 * recording of Launch27's own save (docs/availability.md › Waiting for a recording).
 */
export const VERIFIED = { weekly: false, exclude: false };
export const weeklyRequest = (teamId, rows) => ({
  method: 'POST',
  path: `/v1/staff/teams/${Number(teamId)}/availability`,
  body: rows.map((r) => ({ weekday: r.weekday, date: null, dayoff: !!r.dayoff, start_time: r.dayoff ? null : r.start_time, end_time: r.dayoff ? null : r.end_time })),
});
export const excludeRequest = (teamId, excluded) => ({
  method: 'PUT',
  path: `/v1/staff/teams/${Number(teamId)}`,
  body: { options: { excluded_from_spots: !!excluded } },
});
