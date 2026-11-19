// Synthetic KPI data for dev and QA: invented clients and cleaners, deterministic for a given
// day, from January 2024 to today. It is shaped like the real sources after normalizing
// (connectors.js) and deliberately contains the awkward cases the rules must handle. The
// edge cases sit in the last closed month so they are on screen by default.
import { addDays, addMonths, monthOf, monthsBetween, monthStart, monthEnd, lastClosedMonth, dayOf } from './calc.js';
import { KPI_RULES } from './config.js';

function rng(seed) {
  let s = seed % 2147483647 || 1;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return { next, int: (n) => Math.floor(next() * n), pick: (arr) => arr[Math.floor(next() * arr.length)], chance: (p) => next() < p };
}

const FIRST = ['Amelia', 'Noah', 'Priya', 'Lucas', 'Mei', 'Omar', 'Chloe', 'Ethan', 'Sofia', 'Liam', 'Aisha', 'Mateo', 'Hannah', 'Daniel', 'Zoe', 'Ravi', 'Emma', 'Julien', 'Nadia', 'Owen', 'Camille', 'Victor', 'Grace', 'Felix', 'Ines', 'Marcus', 'Layla', 'Simone', 'Andre', 'Yuki'];
const LAST = ['Tremblay', 'Roy', 'Gagnon', 'Singh', 'Chen', 'Martin', 'Bouchard', 'Okafor', 'Campbell', 'Nguyen', 'Lavoie', 'Fortin', 'Haddad', 'Morin', 'Pelletier', 'Wong', 'Bergeron', 'Ali', 'Girard', 'Fraser', 'Dubois', 'Kowalski', 'Mercier', 'Ahmed', 'Leblanc', 'Sato'];
const CLEANERS = ['Rosa M.', 'Ibrahim K.', 'Lin T.', 'Marta S.', 'Daniela P.', 'Kofi A.', 'Elena V.', 'Sam B.', 'Farah N.', 'Joanne L.', 'Tomas R.', 'Anh D.'];
const STAFF = ['Jimmy', 'Kimmy', 'Grace', 'Jetrin'];
const FREQS = [
  { name: 'Biweekly - 10% off', step: 14, w: 50 },
  { name: 'Weekly - 15% off', step: 7, w: 14 },
  { name: 'Monthly - 5% off', step: 28, w: 24 },
  { name: 'Triweekly - 7% off', step: 21, w: 6 },
  { name: 'Prepaid Biweekly', step: 14, w: 6 },
];
const PERMANENT = ['Moving out of Ottawa', 'Too expensive right now', 'Found another cleaner', 'Not happy with the last few cleans', 'Sold the house', 'No longer needs the service', 'Budget cuts at home', 'Hired a live-in housekeeper', 'Switching to cleaning themselves'];
const TEMPORARY = ['Travelling for three months', 'On hold for the winter', 'Kitchen renovation until spring', 'Pause - postpartum help from family', 'Unit is on Airbnb for the summer', 'Client on vacation, will call when back'];
const SKIP_CLIENT = ['Client sick this week', 'Out of town for this visit', 'Guests staying, skip this one', 'Client asked to skip'];
const COMPANY = ['Cleaner called in sick', 'Cleaner no-show', 'Unable to staff this slot', 'We rescheduled - cleaner unavailable', 'Cleaner cancelled last minute'];
const VAGUE = ['Cancelled', 'Per phone call', 'See notes'];
const COMPLAINTS = ['Missed the bathrooms', 'Arrived late and rushed', 'Broken vase in living room', 'Floors still dirty', 'Different cleaner than promised', 'Did not finish the kitchen'];
const REVIEW_TEXT = ['Reliable and thorough every time.', 'Great team, house looks amazing.', 'Easy booking and friendly cleaners.', 'Very happy with the deep clean.', 'Good, a few spots missed.', 'Late arrival but fixed quickly.'];

const pad = (n) => String(n).padStart(2, '0');
const at = (date, hour, minute = 0) => `${date}T${pad(hour)}:${pad(minute)}`;
const plusMinutes = (t, n) => new Date(Date.parse(`${t}:00Z`) + n * 60_000).toISOString().slice(0, 16);

/**
 * Build the dataset as of `today` ('YYYY-MM-DD').
 * outage: null | 'launch27_stale' | 'kustomer_missing' | 'syft_missing' | 'google_stale' | 'qbo_missing'
 * (dev/QA only: shows how tiles behave when a source is down).
 */
export function buildSyntheticDataset({ today, now = Date.now(), outage = null, rules = KPI_RULES }) {
  const r = rng(20240101);
  const first = `${rules.firstMonth}-01`;
  const horizon = addDays(today, 35);
  const bookings = [];
  const complaints = [];
  let bid = 500_000;
  let cid = 9_000;
  let kid = 70_000;
  // Seasonal churn pressure: a little higher in January and September.
  const hazard = (date) => 0.118 * ({ '01': 1.25, '09': 1.15, '06': 0.9, '11': 0.92 }[date.slice(5, 7)] || 1);
  const pickFreq = () => {
    let x = r.int(100);
    return FREQS.find((f) => (x -= f.w) < 0) || FREQS[0];
  };

  function visit(c, date, freq, over = {}) {
    const past = date < today;
    const hour = c.hour;
    const start = at(date, hour);
    const b = { id: ++bid, customer_id: c.id, customer: c.name, date, start, created_at: at(c.created > date ? addDays(date, -3) : c.created, 10), frequency: freq, completed: false, cleaner: c.cleaner, checkin_at: null, rating: null, rated_at: null, rating_comment: null, cancellation: null, ...over };
    if (past && !b.cancellation && over.completed !== false) {
      if (r.chance(0.004)) b.completed = false; // nobody checked in
      else {
        b.completed = true;
        b.checkin_at = plusMinutes(start, r.chance(0.035) ? 35 + r.int(40) : r.int(22) - 4);
        if (r.chance(0.22)) {
          const x = r.next();
          b.rating = x < 0.055 ? 0 : x < 0.2 ? 1 : 2;
          b.rated_at = addDays(date, r.int(3));
          if (b.rating === 0) b.rating_comment = r.pick(COMPLAINTS);
        }
      }
    }
    bookings.push(b);
    return b;
  }
  const cancel = (date, reason, by = 'customer', hour = 14) => ({ at: at(date, hour), reason, by, by_name: by === 'staff' ? r.pick(STAFF) : null });
  const person = (name) => ({ id: ++cid, name: name || `${r.pick(FIRST)} ${r.pick(LAST)}`, cleaner: r.pick(CLEANERS), hour: 8 + r.int(8), created: first });

  // Complaint objects in Kustomer: some for a visit that also got a bottom rating (dedupe),
  // some by phone or email with no visit attached.
  function maybeComplain(c, b) {
    let complained = false;
    if (b.rating === 0 && r.chance(0.45)) {
      complaints.push({ id: ++kid, customer_id: c.id, customer: c.name, booking_id: r.chance(0.5) ? b.id : null, date: addDays(b.rated_at, r.int(2)), channel: 'email', summary: b.rating_comment });
      complained = true;
    } else if (b.completed && r.chance(0.007)) {
      complaints.push({ id: ++kid, customer_id: c.id, customer: c.name, booking_id: r.chance(0.6) ? b.id : null, date: addDays(b.date, 1 + r.int(3)), channel: r.pick(['phone', 'email']), summary: r.pick(COMPLAINTS) });
      complained = true;
    }
    return complained || b.rating === 0;
  }

  // One recurring client's life: visits on a rhythm until a cancellation ends or pauses it.
  function series(c, startDate, freq) {
    let date = startDate;
    let leaveAfter = null; // a complaint that was not saved: cancels within weeks
    while (date <= horizon) {
      const next = addDays(date, freq.step);
      // A single visit skipped or dropped; the series carries on.
      if (date < today && r.chance(0.03)) {
        const x = r.next();
        const when = addDays(date, -(x < 0.5 ? 1 + r.int(5) : r.int(2)));
        visit(c, date, freq.name, { cancellation: x < 0.5 ? cancel(when, r.pick(SKIP_CLIENT)) : x < 0.9 ? cancel(when, r.pick(COMPANY), 'staff') : cancel(when, r.pick(VAGUE), 'staff') });
        date = next;
        continue;
      }
      const b = visit(c, date, freq.name);
      if (date >= today) {
        date = next;
        continue;
      }
      if (maybeComplain(c, b) && !leaveAfter && r.chance(0.32)) leaveAfter = addDays(date, 5 + r.int(35));
      const leaving = leaveAfter && leaveAfter < next;
      if (leaving || r.chance(hazard(date) * (freq.step / 30))) {
        const when = leaving ? leaveAfter : addDays(date, 1 + r.int(Math.max(1, freq.step - 2)));
        if (when >= today) return;
        const x = leaving ? 0 : r.next();
        if (x < 0.74) {
          visit(c, next, freq.name, { cancellation: cancel(when, leaving ? 'Not happy with the last few cleans' : r.pick(PERMANENT), r.chance(0.35) ? 'staff' : 'customer') });
          // A few come back months later on a new plan (the earlier cancellation stops counting).
          if (!leaving && r.chance(0.07)) series(c, addDays(when, 60 + r.int(120)), pickFreq());
          return;
        }
        if (x < 0.9) {
          visit(c, next, freq.name, { cancellation: cancel(when, r.pick(TEMPORARY), r.chance(0.5) ? 'staff' : 'customer') });
          if (r.chance(0.55)) series(c, addDays(when, 30 + r.int(75)), freq);
          return;
        }
        if (x < 0.93) {
          visit(c, next, freq.name, { cancellation: cancel(when, 'Transferred to LuxoClean (Kitchener-Waterloo)', 'staff') });
          return;
        }
        // Admin error: cancelled by mistake, rebooked on the same rhythm.
        visit(c, next, freq.name, { cancellation: cancel(when, 'Admin error - duplicate booking', 'staff') });
        date = addDays(next, freq.step);
        continue;
      }
      date = next;
    }
  }

  // Recurring book: 250 clients at the start, then new sign-ups every month.
  for (let i = 0; i < 250; i++) series(person(), addDays(first, r.int(28)), pickFreq());
  for (const m of monthsBetween(rules.firstMonth, monthOf(today))) {
    const signups = 27 + r.int(9);
    for (let i = 0; i < signups; i++) {
      const start = addDays(monthStart(m), r.int(28));
      if (start >= today) continue;
      const c = person();
      c.created = addDays(start, -(4 + r.int(10)));
      series(c, start, pickFreq());
    }
    // One-time work: deep cleans and move-outs, a few booked at the last minute.
    for (let i = 0; i < 55 + r.int(20); i++) {
      const date = addDays(monthStart(m), r.int(28));
      if (date > horizon) continue;
      const c = person();
      c.created = addDays(date, -(r.chance(0.08) ? 1 : 3 + r.int(18)));
      const cancelled = date < today && r.chance(0.05);
      const b = visit(c, date, r.chance(0.1) ? 'Prepaid One time' : 'One time', cancelled ? { cancellation: cancel(addDays(date, -1 - r.int(3)), r.pick(SKIP_CLIENT)) } : {});
      maybeComplain(c, b);
    }
  }
  // Institutional programs under the residential book (left out of churn).
  for (const name of ['Carefor Health & Community Services', 'OWCS Homemaking Program', 'Bruyère Home Support']) {
    for (let i = 0; i < 6; i++) series(person(`${name} - client ${i + 1}`), addDays(first, r.int(14)), FREQS[1]);
  }

  // ----- Edge cases, placed in the last closed month -----
  const lm = lastClosedMonth(today, rules);
  const d = (n) => `${lm}-${pad(n)}`;
  const before = (c, freq, until, n = 4) => {
    for (let i = n; i >= 1; i--) visit(c, addDays(until, -i * freq.step), freq.name);
  };
  const edge = (name, freq = FREQS[0]) => {
    const c = person(name);
    c.created = addDays(d(1), -120);
    return [c, freq];
  };
  // Test entries (by name) and a test reason on an ordinary name.
  for (const name of ['Leslie Test', 'leslietest', 'Simon Test']) {
    const [c, f] = edge(name);
    before(c, f, d(6));
    visit(c, d(6), f.name, { cancellation: cancel(d(4), 'Testing cancellation flow', 'staff') });
  }
  {
    const [c, f] = edge('Morgan Ellery');
    before(c, f, d(9));
    visit(c, d(9), f.name, { cancellation: cancel(d(7), 'test booking - ignore', 'staff') });
  }
  // Institutional client that cancels.
  {
    const [c, f] = edge('Metis Nation Homemaking - client A', FREQS[1]);
    before(c, f, d(10));
    visit(c, d(10), f.name, { cancellation: cancel(d(8), 'Program funding ended', 'staff') });
  }
  // Transfer to LuxoClean.
  {
    const [c, f] = edge('Harriet Vance');
    before(c, f, d(12));
    visit(c, d(12), f.name, { cancellation: cancel(d(9), 'KW client - transferred to LuxoClean', 'staff') });
  }
  // Cancels, then returns later the same month on a new plan: not permanent.
  {
    const [c, f] = edge('Desmond Achebe');
    before(c, f, d(5));
    visit(c, d(5), f.name, { cancellation: cancel(d(3), 'Moving in with family') });
    for (let x = d(22); x <= horizon; x = addDays(x, 28)) visit(c, x, 'Monthly - 5% off');
  }
  // Cancels twice in one month (rebooked, then cancelled again before a visit): one event.
  {
    const [c, f] = edge('Beatrice Lindqvist');
    before(c, f, d(6));
    visit(c, d(6), f.name, { cancellation: cancel(d(3), 'Too expensive right now') });
    visit(c, d(21), f.name, { cancellation: cancel(d(19), 'Decided to stop after all') });
  }
  // Prepaid: a one-time prepaid is not recurring; a prepaid plan is.
  {
    const [c] = edge('Quentin Abara');
    visit(c, d(14), 'Prepaid One time', { cancellation: cancel(d(11), 'No longer needs the service') });
    const [c2, f2] = edge('Rosalind Okoye', FREQS[4]);
    before(c2, f2, d(15));
    visit(c2, d(15), f2.name, { cancellation: cancel(d(13), 'Prepaid package used up, not renewing') });
  }
  // Temporary, and an admin over-cancellation (staff cancelled a series for a holiday).
  {
    const [c, f] = edge('Ingrid Solberg');
    before(c, f, d(16));
    visit(c, d(16), f.name, { cancellation: cancel(d(12), 'Client away on vacation - cancelled series', 'staff') });
    const [c2, f2] = edge('Theo Marchetti');
    before(c2, f2, d(18));
    visit(c2, d(18), f2.name, { cancellation: cancel(d(17), 'Preferred cleaner not available, client declined', 'staff') });
  }
  // Two complaint objects for the same visit, plus its bottom rating: one complaint.
  {
    const [c, f] = edge('Colette Fairbanks');
    before(c, f, d(8), 3);
    const b = visit(c, d(8), f.name, { completed: false });
    Object.assign(b, { completed: true, checkin_at: plusMinutes(b.start, 4), rating: 0, rated_at: d(9), rating_comment: 'Bathrooms were skipped' });
    complaints.push({ id: ++kid, customer_id: c.id, customer: c.name, booking_id: b.id, date: d(9), channel: 'email', summary: 'Bathrooms were skipped' });
    complaints.push({ id: ++kid, customer_id: c.id, customer: c.name, booking_id: b.id, date: d(10), channel: 'phone', summary: 'Called again about the bathrooms' });
    for (let x = addDays(d(8), 14); x <= horizon; x = addDays(x, 14)) visit(c, x, f.name);
  }

  // ----- Google reviews -----
  const reviews = [];
  let rid = 0;
  for (const m of monthsBetween(rules.firstMonth, monthOf(today))) {
    const n = 9 + r.int(12);
    for (let i = 0; i < n; i++) {
      const date = addDays(monthStart(m), r.int(28));
      if (date >= today) continue;
      const x = r.next();
      const rating = x < 0.82 ? 5 : x < 0.92 ? 4 : x < 0.95 ? 3 : x < 0.97 ? 2 : 1;
      reviews.push({ id: ++rid, date, rating, reviewer: `${r.pick(FIRST)} ${r.pick(LAST)[0]}.`, comment: rating >= 4 ? REVIEW_TEXT[r.int(4)] : REVIEW_TEXT[4 + r.int(2)] });
    }
  }

  // ----- Books: QuickBooks lines per month, and the Syft report's figure -----
  const completedBy = new Map();
  for (const b of bookings) if (b.completed) completedBy.set(monthOf(b.date), (completedBy.get(monthOf(b.date)) || 0) + 1);
  const qbo = [];
  const syft = [];
  const thisMonth = monthOf(today);
  for (const m of monthsBetween(rules.firstMonth, thisMonth)) {
    const revenue = Math.round((completedBy.get(m) || 0) * (182 + r.int(14)));
    if (!revenue) continue;
    const line = (account, category, share) => ({ account, category, amount: Math.round(revenue * share) });
    const lines = [
      line('5010 Cleaner wages - employees', 'cleaner_wages', 0.27 + r.next() * 0.02),
      line('5020 Cleaner subcontractors', 'cleaner_wages', 0.15 + r.next() * 0.015),
      line('5030 Payroll taxes, EI, CPP - cleaners', 'cleaner_payroll_taxes', 0.031 + r.next() * 0.004),
      line('5035 WSIB - cleaners', 'cleaner_payroll_taxes', 0.009),
      line('5100 Cleaning supplies', 'supplies', 0.019 + r.next() * 0.005),
      line('5200 Fuel and mileage - field', 'field_vehicle', 0.011 + r.next() * 0.003),
      line('5210 Vehicle insurance - field', 'field_vehicle', 0.004),
      line('6010 Wages - scheduling and operations', 'ops_staff', 0.064 + r.next() * 0.008),
      line('6100 Software - Launch27, Kustomer, RingCentral', 'ops_software', 0.011),
      line('6200 Recruitment advertising', 'recruitment_ads', 0.006 + r.next() * 0.004),
      line('6500 Office rent', 'office_rent', 0.024),
      line('6510 Insurance - general liability', 'general_insurance', 0.008),
      line('6600 Marketing and advertising', 'other', 0.045),
    ];
    qbo.push({ month: m, revenue, lines });
    const included = lines.filter((l) => l.category in rules.ocrIncluded).reduce((t, l) => t + l.amount, 0);
    // Syft lands around the 9th of the following month. One month disagrees with QBO by more
    // than a point (a reclassified subcontractor bill), to show the flag.
    const received = `${addMonths(m, 1)}-09`;
    if (received <= today && !(outage === 'syft_missing' && m === lm)) {
      const off = m === addMonths(lm, -2) ? 1.6 : (r.next() - 0.5) * 0.8;
      syft.push({ month: m, ocr_pct: Math.round(((included / revenue) * 100 + off) * 10) / 10, received_at: received, file: `Management Financial Report - ${m}.pdf` });
    } else r.next();
  }

  const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();
  const sources = {
    launch27: { refreshed_at: hoursAgo(outage === 'launch27_stale' ? 61 : 3), note: 'Synthetic data' },
    kustomer: outage === 'kustomer_missing' ? { refreshed_at: null, note: 'not connected' } : { refreshed_at: hoursAgo(5), note: 'Synthetic data' },
    google: { refreshed_at: hoursAgo(outage === 'google_stale' ? 75 : 9), note: 'Synthetic data' },
    qbo: outage === 'qbo_missing' ? { refreshed_at: null, note: 'not connected' } : { refreshed_at: hoursAgo(20), note: 'Synthetic data' },
    syft: { refreshed_at: hoursAgo(20), note: 'Synthetic data' },
  };
  return { brand: 'urbanmop', synthetic: true, built_for: today, sources, bookings, complaints: outage === 'kustomer_missing' ? [] : complaints, reviews, reviewBaseline: { count: 412, avg: 4.71 }, ocr: { qbo: outage === 'qbo_missing' ? [] : qbo, syft }, manualReviews: {}, edge_month: lm, edge_month_end: monthEnd(lm), as_of: dayOf(today) };
}
