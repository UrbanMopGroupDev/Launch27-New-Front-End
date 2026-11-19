import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { indexDataset, isRecurring, isTest, isInstitutional, reasonCategory, churnBand, isOverCancel, cancellationCause, churnMonth, fulfilmentMonth, complaintsMonth, reviewsMonth, ocrMonth, scorecard, drill, lastClosedMonth, sourceState } from '../src/kpi/calc.js';
import { KPI_BRANDS, KPI_RULES } from '../src/kpi/config.js';
import { buildSyntheticDataset } from '../src/kpi/synthetic.js';
import { createKpi, canSeeKpi } from '../src/kpi/service.js';
import { createKpiConnectors } from '../src/kpi/connectors.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const TODAY = '2026-11-19';
const NOW = Date.parse('2026-11-19T15:00:00Z');
const FRESH = new Date(NOW - 3_600_000).toISOString();
const SOURCES = { launch27: { refreshed_at: FRESH }, kustomer: { refreshed_at: FRESH }, google: { refreshed_at: FRESH }, qbo: { refreshed_at: FRESH }, syft: { refreshed_at: FRESH } };

let nextId = 1;
// A booking: b(customerId, name, date, { ...overrides }). Past visits are completed and on time.
const b = (cid, name, date, over = {}) => ({ id: nextId++, customer_id: cid, customer: name, date, start: `${date}T09:00`, created_at: '2026-01-05T10:00', frequency: 'Biweekly - 10% off', completed: !over.cancellation && date < TODAY, cleaner: 'Rosa M.', checkin_at: !over.cancellation && date < TODAY ? `${date}T09:05` : null, rating: null, rated_at: null, cancellation: null, ...over });
const cx = (date, reason, by = 'customer') => ({ at: `${date}T14:00`, reason, by, by_name: by === 'staff' ? 'Kimmy' : null });
const ix = (bookings, extra = {}) => indexDataset({ sources: SOURCES, bookings, complaints: [], reviews: [], reviewBaseline: { count: 100, avg: 4.5 }, ocr: { qbo: [], syft: [] }, manualReviews: {}, ...extra });
const outcome = (res, name) => res.events.find((e) => e.customer === name)?.outcome;

describe('kpi rules', () => {
  test('recurring: weekly, biweekly, triweekly, monthly, prepaid; never one-time', () => {
    for (const f of ['Weekly - 15% off', 'Bi-Weekly', 'Biweekly - 10% off', 'Triweekly', 'Monthly - 5% off', 'Prepaid Biweekly', 'Prepaid package']) assert.equal(isRecurring(f), true, f);
    for (const f of ['One time', 'One-Time', 'Prepaid One time', 'Onetime deep clean', '', null]) assert.equal(isRecurring(f), false, String(f));
  });
  test('test entries: the listed names and the word "test" in a name or reason', () => {
    for (const n of ['Leslie T', 'leslie tam', 'LeslieTest', 'Simon Test', 'Les Tee', 'QA Test Client']) assert.equal(isTest(n), true, n);
    assert.equal(isTest('Morgan Ellery', 'test booking - ignore'), true);
    for (const n of ['Leslie Thompson', 'Tess Contestabile', 'Esther Latest']) assert.equal(isTest(n, 'Moving'), false, n);
  });
  test('institutional clients, accents ignored', () => {
    for (const n of ['Carefor Health', 'OWCS program', 'Bruyère Home Support', 'City Homemaking', 'MFT group', 'Metis Nation', 'DigiRealty', 'Spark Lifecare', 'Corretto Inc']) assert.equal(isInstitutional(n), true, n);
    assert.equal(isInstitutional('Amelia Tremblay'), false);
  });
  test('reason categories', () => {
    assert.equal(reasonCategory('Transferred to LuxoClean').key, 'luxo_transfer');
    assert.equal(reasonCategory('Kitchener-Waterloo client').key, 'luxo_transfer');
    for (const r of ['Travelling for 3 months', 'On hold', 'Pause until June', 'Kitchen renovation', 'Unit on Airbnb', 'Postpartum help', 'On vacation']) assert.equal(reasonCategory(r).key, 'temporary', r);
    assert.equal(reasonCategory('Admin error - duplicate booking').key, 'admin_error');
    for (const r of ['Moving out of Ottawa', 'Too expensive', 'Moved away', '']) assert.equal(reasonCategory(r), null, r);
  });
  test('churn bands: ≤7 Excellent, 7–10 Healthy, 10–12 Elevated, over 12 High', () => {
    assert.deepEqual([5, 7, 7.1, 10, 10.1, 12, 12.1].map((x) => churnBand(x).label), ['Excellent', 'Excellent', 'Healthy', 'Healthy', 'Elevated', 'Elevated', 'High']);
  });
  test('admin over-cancellation: staff cancellations with a flagged reason only', () => {
    for (const r of ['Client on vacation', 'travel', 'Away until May', 'Reschedule requested', 'on hold', 'Pause', 'No-show', 'cleaner cancelled', 'Preferred cleaner unavailable', 'Last minute change']) assert.equal(isOverCancel(cx('2026-10-05', r, 'staff')), true, r);
    assert.equal(isOverCancel(cx('2026-10-05', 'Client on vacation', 'customer')), false);
    assert.equal(isOverCancel(cx('2026-10-05', 'Moving out of Ottawa', 'staff')), false);
  });
  test('fulfilment mapping: who caused a cancellation', () => {
    const cause = (reason, by) => cancellationCause(cx('2026-10-05', reason, by));
    assert.deepEqual(cause('Cleaner no-show', 'staff'), { cause: 'company', label: 'Cleaner no-show' });
    assert.equal(cause('Cleaner called in sick', 'staff').label, 'Cleaner cancelled');
    assert.equal(cause('Unable to staff this slot', 'staff').label, 'Unable to staff');
    assert.equal(cause('We rescheduled - cleaner unavailable', 'staff').label, 'We rescheduled');
    assert.equal(cause('Changed my mind', 'customer').cause, 'client');
    assert.equal(cause('Client sick this week', 'staff').cause, 'client');
    assert.equal(cause('Cancelled', 'staff').cause, 'unclassified');
    // Company-caused wins even when the client clicked cancel.
    assert.equal(cause('Cleaner no-show so I cancelled', 'customer').cause, 'company');
  });
  test('last closed month follows the close day', () => {
    assert.equal(lastClosedMonth('2026-11-19'), '2026-10');
    assert.equal(lastClosedMonth('2026-11-10'), '2026-10');
    assert.equal(lastClosedMonth('2026-11-09'), '2026-09');
    assert.equal(lastClosedMonth('2026-01-05'), '2025-11');
  });
});

describe('churn', () => {
  // Ten ordinary recurring clients active through October, plus the cases under test.
  const steady = () => Array.from({ length: 10 }, (_, i) => [b(100 + i, `Steady ${i}`, '2026-10-06'), b(100 + i, `Steady ${i}`, '2026-10-20'), b(100 + i, `Steady ${i}`, '2026-11-03')]).flat();
  const res = (extra) => churnMonth(ix([...steady(), ...extra]), '2026-10', TODAY);

  test('events ÷ active recurring clients at the start of the month', () => {
    const r = res([b(1, 'Gone One', '2026-10-02'), b(1, 'Gone One', '2026-10-16', { cancellation: cx('2026-10-10', 'Moving out of Ottawa') })]);
    assert.equal(r.num, 1);
    assert.equal(r.den, 11);
    assert.ok(Math.abs(r.value - (1 / 11) * 100) < 1e-9);
    assert.equal(outcome(r, 'Gone One'), 'Counted as churn');
  });
  test('dated by the cancellation date, not the visit date; last cleaner comes from the last completed visit', () => {
    const extra = [b(1, 'Late Visit', '2026-10-02', { cleaner: 'Kofi A.' }), b(1, 'Late Visit', '2026-11-04', { cancellation: cx('2026-10-28', 'Too expensive'), cleaner: 'Lin T.' })];
    const oct = res(extra);
    assert.equal(oct.num, 1);
    assert.equal(oct.events[0].last_cleaner, 'Kofi A.');
    assert.equal(churnMonth(ix([...steady(), ...extra]), '2026-11', TODAY).num, 0);
  });
  test('test entries and institutional clients are out of numerator and denominator', () => {
    const r = res([
      b(1, 'Leslie Test', '2026-10-05', { cancellation: cx('2026-10-03', 'Moving') }),
      b(2, 'Carefor Health - client 1', '2026-10-05', { cancellation: cx('2026-10-03', 'Program ended') }),
      b(3, 'Morgan Ellery', '2026-10-05', { cancellation: cx('2026-10-03', 'test booking') }),
      b(4, 'Simon Test', '2026-10-07'),
      b(5, 'Bruyère Home Support', '2026-10-07'),
    ]);
    assert.equal(r.num, 0);
    assert.equal(outcome(r, 'Leslie Test'), 'Excluded: test entry');
    assert.equal(outcome(r, 'Carefor Health - client 1'), 'Excluded: institutional client');
    assert.equal(outcome(r, 'Morgan Ellery'), 'Excluded: test entry');
    // Morgan is a real client with a test reason: still in the base. The test and institutional names are not.
    assert.equal(r.den, 11);
    assert.deepEqual(r.base.map((x) => x.customer).filter((n) => !n.startsWith('Steady')), ['Morgan Ellery']);
  });
  test('one-time and prepaid one-time are not recurring; a prepaid plan is', () => {
    const r = res([
      b(1, 'One Timer', '2026-10-05', { frequency: 'One time', cancellation: cx('2026-10-03', 'No longer needed') }),
      b(2, 'Prepaid Once', '2026-10-05', { frequency: 'Prepaid One time', cancellation: cx('2026-10-03', 'No longer needed') }),
      b(3, 'Prepaid Plan', '2026-10-05', { frequency: 'Prepaid Biweekly', cancellation: cx('2026-10-03', 'Not renewing') }),
    ]);
    assert.equal(outcome(r, 'One Timer'), 'Excluded: one-time booking');
    assert.equal(outcome(r, 'Prepaid Once'), 'Excluded: one-time booking');
    assert.equal(outcome(r, 'Prepaid Plan'), 'Counted as churn');
    assert.equal(r.num, 1);
    assert.equal(r.den, 11);
  });
  test('LuxoClean transfers and admin errors are not churn, but stay in the base', () => {
    const r = res([b(1, 'Luxo', '2026-10-05', { cancellation: cx('2026-10-03', 'Transferred to LuxoClean', 'staff') }), b(7, 'Oops', '2026-10-05', { cancellation: cx('2026-10-03', 'Admin error', 'staff') })]);
    assert.equal(r.num, 0);
    assert.equal(r.den, 12);
    assert.equal(outcome(r, 'Luxo'), 'Excluded: transfer to luxoclean');
    assert.equal(outcome(r, 'Oops'), 'Excluded: admin error');
  });
  test('temporary cancellations: back within 90 days is not churn; no return after 90 days is; pending until then', () => {
    const june = (extra) => churnMonth(ix([b(50, 'Steady', '2026-06-02'), ...extra]), '2026-06', TODAY);
    const away = (id, name, reason = 'Travelling for the summer') => [b(id, name, '2026-06-01'), b(id, name, '2026-06-15', { cancellation: cx('2026-06-10', reason) })];
    const r = june([
      ...away(1, 'Back In 30'), b(1, 'Back In 30', '2026-07-05'),
      ...away(2, 'Back In 60', 'On hold'), b(2, 'Back In 60', '2026-08-01'),
      ...away(3, 'Back In 90', 'Renovation'), b(3, 'Back In 90', '2026-09-08'),
      ...away(4, 'Back Too Late', 'Airbnb for the season'), b(4, 'Back Too Late', '2026-09-09'),
      ...away(5, 'Never Back', 'Postpartum, family helping'),
      ...away(6, 'One Time Later'), b(6, 'One Time Later', '2026-07-01', { frequency: 'One time' }),
    ]);
    assert.equal(outcome(r, 'Back In 30'), 'Excluded: temporary, back within 30 days');
    assert.equal(outcome(r, 'Back In 60'), 'Excluded: temporary, back within 60 days');
    assert.equal(outcome(r, 'Back In 90'), 'Excluded: temporary, back within 90 days');
    for (const n of ['Back Too Late', 'Never Back', 'One Time Later']) assert.equal(outcome(r, n), 'Counted as churn (temporary, no return within 90 days)', n);
    assert.equal(r.num, 3);
    // Still inside the window: not counted yet, and reported as pending.
    const recent = res([b(1, 'Just Left', '2026-10-02'), b(1, 'Just Left', '2026-10-16', { cancellation: cx('2026-10-10', 'Travelling until spring') })]);
    assert.equal(outcome(recent, 'Just Left'), 'Pending: temporary, inside the 90-day return window');
    assert.deepEqual([recent.num, recent.pending], [0, 1]);
  });
  test('came back: a later active recurring booking means it was not permanent', () => {
    const r = res([
      b(1, 'Returner', '2026-10-05', { cancellation: cx('2026-10-03', 'Moving in with family') }),
      b(1, 'Returner', '2026-10-22', { frequency: 'Monthly - 5% off' }),
      // A later one-time booking, or a later booking that was itself cancelled, is not coming back.
      b(2, 'One Off Later', '2026-10-05', { cancellation: cx('2026-10-03', 'Too expensive') }),
      b(2, 'One Off Later', '2026-10-25', { frequency: 'One time' }),
      b(3, 'Skipper', '2026-10-06', { cancellation: cx('2026-10-04', 'Client sick this week') }),
      b(3, 'Skipper', '2026-10-20'),
    ]);
    assert.equal(outcome(r, 'Returner'), 'Excluded: came back (later active recurring booking)');
    assert.equal(outcome(r, 'One Off Later'), 'Counted as churn');
    assert.match(outcome(r, 'Skipper'), /came back/);
    assert.equal(r.num, 1);
  });
  test('at most one churn event per client per calendar month', () => {
    const r = res([b(1, 'Twice', '2026-10-06', { cancellation: cx('2026-10-03', 'Too expensive') }), b(1, 'Twice', '2026-10-21', { cancellation: cx('2026-10-19', 'Stopping after all') })]);
    assert.equal(r.num, 1);
    assert.deepEqual(r.events.map((e) => e.outcome), ['Counted as churn', 'Excluded: second event this month']);
  });
  test('base: a recurring visit in the month still on the books on the 1st', () => {
    const r = res([
      b(1, 'Left In September', '2026-10-05', { cancellation: cx('2026-09-28', 'Moving') }), // gone before the month started
      b(2, 'One Time Only', '2026-10-05', { frequency: 'One time' }),
      b(3, 'Starts November', '2026-11-05'),
    ]);
    assert.equal(r.den, 10);
  });
  test('over-cancellation flags are counted and listed', () => {
    const r = res([b(1, 'Flagged', '2026-10-05', { cancellation: cx('2026-10-03', 'Client on vacation - cancelled series', 'staff') }), b(2, 'Fine', '2026-10-05', { cancellation: cx('2026-10-03', 'On vacation') })]);
    assert.deepEqual(r.over_cancel.map((e) => e.customer), ['Flagged']);
  });
  test('no recurring clients: no data, not zero', () => {
    const r = churnMonth(ix([]), '2026-10', TODAY);
    assert.equal(r.state, 'no_data');
    assert.equal(r.value, null);
  });
});

describe('service fulfilment', () => {
  const rows = () => [
    b(1, 'On Time', '2026-10-05'),
    b(2, 'Exactly 30', '2026-10-05', { checkin_at: '2026-10-05T09:30' }),
    b(3, 'Late 31', '2026-10-05', { checkin_at: '2026-10-05T09:31' }),
    b(4, 'No Check-in', '2026-10-06', { completed: false, checkin_at: null }),
    b(5, 'Cleaner Sick', '2026-10-06', { cancellation: cx('2026-10-06', 'Cleaner called in sick', 'staff') }),
    b(6, 'Client Cancelled', '2026-10-07', { cancellation: cx('2026-10-01', 'Changed plans') }),
    b(7, 'Vague', '2026-10-07', { cancellation: cx('2026-10-06', 'Cancelled', 'staff') }),
    b(8, 'Simon Test', '2026-10-07'),
    b(9, 'Booked Late', '2026-10-08', { created_at: '2026-10-07T15:00' }),
  ];
  test('completed ÷ scheduled: late is still fulfilled; anything not completed is not, whoever caused it', () => {
    const r = fulfilmentMonth(ix(rows()), '2026-10', TODAY);
    // fulfilled: On Time, Exactly 30, Late 31, Booked Late. not: No Check-in, Cleaner Sick, Client Cancelled, Vague.
    assert.equal(r.num, 4);
    assert.equal(r.den, 8);
    assert.equal(r.value, 50);
    assert.deepEqual([r.company, r.client, r.unclassified, r.late], [2, 1, 1, 1]);
    assert.deepEqual(r.misses.map((m) => [m.kind, m.label, m.n]), [['company', 'Not completed (no check-in)', 1], ['company', 'Cleaner cancelled', 1], ['client', 'Client cancelled', 1], ['unclassified', 'Unclassified staff cancellation', 1]]);
    assert.ok(!r.rows.some((x) => x.customer === 'Simon Test'));
    assert.equal(r.rows.find((x) => x.customer === 'Late 31').result, 'Completed, arrived late (over 30 min)');
    assert.equal(r.rows.find((x) => x.customer === 'Exactly 30').late, false);
  });
  test('late threshold is configurable', () => {
    assert.equal(fulfilmentMonth(ix(rows()), '2026-10', TODAY, { ...KPI_RULES, lateMinutes: 45 }).late, 0);
    assert.equal(fulfilmentMonth(ix(rows()), '2026-10', TODAY, { ...KPI_RULES, lateMinutes: 20 }).late, 2);
  });
  test('48-hour snapshot and weekly split', () => {
    const r = fulfilmentMonth(ix(rows()), '2026-10', TODAY);
    // On the books 48 h ahead: all but the client who cancelled a week early and the late booking.
    assert.deepEqual([r.snapshot.on_books, r.snapshot.completed, r.snapshot.added_late], [6, 3, 1]);
    assert.equal(r.weeks[0].from, '2026-10-01');
    assert.equal(r.weeks[0].to, '2026-10-04');
    assert.equal(r.weeks[1].den, 8);
    assert.equal(r.weeks.at(-1).to, '2026-10-31');
  });
  test('visits that have not happened yet are not counted', () => {
    const r = fulfilmentMonth(ix([b(1, 'Future', '2026-11-25')]), '2026-11', TODAY);
    assert.equal(r.state, 'no_data');
  });
});

describe('complaints', () => {
  const visits = () => Array.from({ length: 50 }, (_, i) => b(200 + i, `Visitor ${i}`, '2026-08-10'));
  test('per 100 completed visits; the same visit or the same client within a week counts once', () => {
    const rated = b(1, 'Rated And Emailed', '2026-08-04', { rating: 0, rated_at: '2026-08-05' });
    const ratedOnly = b(2, 'Rated Only', '2026-08-06', { rating: 0, rated_at: '2026-08-06' });
    const phoned = b(3, 'Phoned', '2026-08-07', { rating: 0, rated_at: '2026-08-08' });
    const okRating = b(4, 'Ok Rating', '2026-08-07', { rating: 1, rated_at: '2026-08-08' });
    const complaints = [
      { id: 1, customer_id: 1, customer: 'Rated And Emailed', booking_id: rated.id, date: '2026-08-05', summary: 'Missed bathrooms' },
      { id: 2, customer_id: 1, customer: 'Rated And Emailed', booking_id: rated.id, date: '2026-08-06', summary: 'Called again' },
      { id: 3, customer_id: 3, customer: 'Phoned', booking_id: null, date: '2026-08-10', summary: 'Phone complaint' },
      { id: 4, customer_id: 5, customer: 'Kustomer Only', booking_id: null, date: '2026-08-20', summary: 'Late' },
      { id: 5, customer_id: 6, customer: 'Leslie Test', booking_id: null, date: '2026-08-20', summary: 'ignore' },
    ];
    const r = complaintsMonth(ix([...visits(), rated, ratedOnly, phoned, okRating], { complaints }), '2026-08', TODAY);
    assert.equal(r.num, 4); // Rated And Emailed, Phoned, Kustomer Only, Rated Only
    assert.equal(r.den, 54);
    assert.ok(Math.abs(r.value - (4 / 54) * 100) < 1e-9);
    assert.deepEqual(r.rows.find((x) => x.customer === 'Rated And Emailed' && x.counted).sources, ['Kustomer', 'Launch27 rating']);
    assert.equal(r.rows.filter((x) => !x.counted).length, 3);
  });
  test('a rating whose complaint object landed in the next month is not counted twice', () => {
    const rated = b(1, 'Month Edge', '2026-08-30', { rating: 0, rated_at: '2026-08-31' });
    const complaints = [{ id: 1, customer_id: 1, customer: 'Month Edge', booking_id: rated.id, date: '2026-09-01', summary: 'x' }];
    const data = ix([...visits(), rated, b(300, 'Sept Visitor', '2026-09-10')], { complaints });
    assert.equal(complaintsMonth(data, '2026-08', TODAY).num, 0);
    assert.equal(complaintsMonth(data, '2026-09', TODAY).num, 1);
  });
  test('saved: still booking 60+ days later, and only once 60 days have passed', () => {
    const complaints = [
      { id: 1, customer_id: 1, customer: 'Stayed', booking_id: null, date: '2026-08-10', summary: 'x' },
      { id: 2, customer_id: 2, customer: 'Left', booking_id: null, date: '2026-08-12', summary: 'x' },
    ];
    const bookings = [...visits(), b(1, 'Stayed', '2026-08-08'), b(1, 'Stayed', '2026-10-20'), b(2, 'Left', '2026-08-10'), b(2, 'Left', '2026-09-01'), b(2, 'Left', '2026-10-25', { cancellation: cx('2026-09-10', 'Not happy') })];
    const r = complaintsMonth(ix(bookings, { complaints }), '2026-08', TODAY);
    assert.deepEqual([r.saved.measurable, r.saved.saved, r.saved.total, r.saved.pct], [true, 1, 2, 50]);
    const early = complaintsMonth(ix(bookings, { complaints }), '2026-08', '2026-10-20');
    assert.equal(early.saved.measurable, false);
    assert.equal(early.saved.pct, null);
    assert.equal(early.saved.measurable_on, '2026-10-30');
  });
});

describe('google reviews', () => {
  const reviews = [{ id: 1, date: '2026-09-03', rating: 5 }, { id: 2, date: '2026-10-03', rating: 5 }, { id: 3, date: '2026-10-09', rating: 4 }, { id: 4, date: '2026-10-20', rating: 3 }, { id: 5, date: '2026-11-02', rating: 1 }];
  const data = (extra = {}) => ix(Array.from({ length: 150 }, (_, i) => b(400 + i, `V ${i}`, '2026-10-12')), { reviews, ...extra });
  test('new reviews, month and all-time averages, per 100 completed visits', () => {
    const r = reviewsMonth(data(), '2026-10');
    assert.equal(r.value, 3);
    assert.equal(r.avg, 4);
    assert.equal(r.per100, 2);
    assert.equal(r.alltime_count, 104); // baseline 100 + Sep + three in Oct; November is not in yet
    assert.ok(Math.abs(r.alltime_avg - (450 + 5 + 12) / 104) < 1e-9);
  });
  test('a manual entry replaces the month and is labelled', () => {
    const r = reviewsMonth(data({ manualReviews: { '2026-10': { new_reviews: 7, avg_rating: 4.6, alltime_avg: 4.7, alltime_count: 500 } } }), '2026-10');
    assert.deepEqual([r.manual, r.value, r.avg, r.alltime_count], [true, 7, 4.6, 500]);
  });
  test('no Google data: no data', () => {
    assert.equal(reviewsMonth(data({ reviews: null, reviewBaseline: null }), '2026-10').state, 'no_data');
  });
});

describe('OCR', () => {
  const line = (category, amount) => ({ account: category, category, amount });
  const qbo = [{ month: '2026-10', revenue: 100_000, lines: [line('cleaner_wages', 42_000), line('cleaner_payroll_taxes', 4_000), line('supplies', 2_000), line('field_vehicle', 1_500), line('ops_staff', 6_500), line('ops_software', 1_000), line('recruitment_ads', 1_000), line('office_rent', 3_000), line('general_insurance', 900), line('other', 5_000)] }];
  const data = (syft) => ix([], { ocr: { qbo, syft } });
  test('included cost ÷ revenue; rent and general insurance stay out', () => {
    const r = ocrMonth(data([]), '2026-10', TODAY);
    assert.equal(r.num, 58_000);
    assert.ok(Math.abs(r.value - 58) < 1e-9);
    assert.deepEqual(r.lines.filter((l) => !l.included).map((l) => l.category), ['office_rent', 'general_insurance', 'other']);
    assert.equal(r.syft, null);
  });
  test('flag only when QBO and Syft differ by more than 1.0 percentage point', () => {
    assert.equal(ocrMonth(data([{ month: '2026-10', ocr_pct: 57 }]), '2026-10', TODAY).flagged, false);
    assert.equal(ocrMonth(data([{ month: '2026-10', ocr_pct: 59.1 }]), '2026-10', TODAY).flagged, true);
    assert.equal(ocrMonth(data([{ month: '2026-10', ocr_pct: 56.9 }]), '2026-10', TODAY).flagged, true);
  });
  test('Provisional until the 10th of the following month, then Final', () => {
    assert.equal(ocrMonth(data([]), '2026-10', '2026-11-09').status, 'Provisional');
    assert.equal(ocrMonth(data([]), '2026-10', '2026-11-10').status, 'Final');
  });
  test('no QBO month: no data, even if Syft has a figure', () => {
    const r = ocrMonth(data([{ month: '2026-09', ocr_pct: 58 }]), '2026-09', TODAY);
    assert.equal(r.state, 'no_data');
    assert.equal(r.value, null);
  });
});

describe('scorecard', () => {
  const brand = KPI_BRANDS[0];
  const build = (outage = null) => indexDataset(buildSyntheticDataset({ today: TODAY, now: NOW, outage }));
  const card = (outage, opts = {}) => scorecard(build(outage), { brand, month: '2026-10', now: NOW, today: TODAY, ...opts });
  const tile = (c, kpi) => c.tiles.find((t) => t.kpi === kpi);

  test('every live tile has a value, period, source, refresh time and formula', () => {
    const c = card();
    for (const t of c.tiles.filter((x) => x.kpi !== 'billing')) {
      assert.equal(t.state, 'ok', t.kpi);
      assert.equal(typeof t.value, 'number');
      assert.equal(t.period, 'Oct 2026');
      assert.ok(t.sources.length && t.refreshed_at && t.formula.length > 40, t.kpi);
      assert.equal(c.trends[t.kpi].length, 12);
    }
    assert.deepEqual([tile(c, 'billing').state, tile(c, 'billing').note, tile(c, 'billing').value], ['disabled', 'Coming later', null]);
  });
  test('month-over-month change is in percentage points and says which way is better', () => {
    const data = build();
    const c = scorecard(data, { brand, month: '2026-10', now: NOW, today: TODAY });
    const oct = churnMonth(data, '2026-10', TODAY).value;
    const sep = churnMonth(data, '2026-09', TODAY).value;
    const d = tile(c, 'churn').delta;
    assert.equal(d.unit, 'pp');
    assert.equal(d.value, Math.round((oct - sep) * 10) / 10);
    assert.equal(d.better, d.value === 0 ? null : d.value < 0);
    assert.equal(tile(c, 'fulfilment').delta.better === true, tile(c, 'fulfilment').delta.value > 0);
  });
  test('a stale or missing source shows no value: never a zero, never last month', () => {
    const stale = card('launch27_stale');
    for (const k of ['churn', 'fulfilment', 'complaints', 'reviews']) assert.deepEqual([tile(stale, k).state, tile(stale, k).value, stale.trends[k]], ['stale', null, undefined], k);
    assert.equal(tile(stale, 'ocr').state, 'ok');
    const noKustomer = card('kustomer_missing');
    assert.deepEqual([tile(noKustomer, 'complaints').state, tile(noKustomer, 'complaints').value], ['no_data', null]);
    assert.equal(tile(noKustomer, 'churn').state, 'ok');
    const noQbo = card('qbo_missing');
    assert.deepEqual([tile(noQbo, 'ocr').state, tile(noQbo, 'ocr').value], ['no_data', null]);
    // Syft missing: QBO still shows, and says Syft has not arrived.
    const noSyft = tile(card('syft_missing'), 'ocr');
    assert.equal(noSyft.state, 'ok');
    assert.equal(noSyft.details.find((d) => d.label === 'Syft reported').value, 'Not received yet');
  });
  test('source freshness: daily sources go stale after 48 hours, monthly ones do not', () => {
    const old = { refreshed_at: new Date(NOW - 49 * 3_600_000).toISOString() };
    assert.equal(sourceState(old, 'launch27', NOW), 'stale');
    assert.equal(sourceState(old, 'qbo', NOW), 'ok');
    assert.equal(sourceState({ refreshed_at: null }, 'kustomer', NOW), 'missing');
  });
  test('the synthetic month carries the edge cases', () => {
    const r = churnMonth(build(), '2026-10', TODAY);
    assert.equal(outcome(r, 'Leslie Test'), 'Excluded: test entry');
    assert.equal(outcome(r, 'Morgan Ellery'), 'Excluded: test entry');
    assert.equal(outcome(r, 'Metis Nation Homemaking - client A'), 'Excluded: institutional client');
    assert.equal(outcome(r, 'Harriet Vance'), 'Excluded: transfer to luxoclean');
    assert.match(outcome(r, 'Desmond Achebe'), /came back/);
    assert.deepEqual(r.events.filter((e) => e.customer === 'Beatrice Lindqvist').map((e) => e.counted), [true, false]);
    assert.equal(outcome(r, 'Quentin Abara'), 'Excluded: one-time booking');
    assert.equal(outcome(r, 'Rosalind Okoye'), 'Counted as churn');
    assert.ok(r.over_cancel.some((e) => e.customer === 'Ingrid Solberg'));
    const flagged = card().trends.ocr.filter((p) => p.flag === 'QBO and Syft differ');
    assert.equal(flagged.length, 1);
  });
  test('trailing 12 pools the months; drill-down rows add up to the tile', () => {
    const data = build();
    const t12 = scorecard(data, { brand, month: '2026-10', mode: 't12', now: NOW, today: TODAY });
    assert.equal(t12.period, 'Nov 2025 – Oct 2026');
    let num = 0;
    let den = 0;
    for (let m = 0; m < 12; m++) {
      const r = churnMonth(data, m < 2 ? `2025-${11 + m}` : `2026-${String(m - 1).padStart(2, '0')}`, TODAY);
      num += r.num;
      den += r.den;
    }
    assert.equal(tile(t12, 'churn').value, Math.round((num / den) * 1000) / 10);
    const d = drill(data, { kpi: 'churn', month: '2026-10', today: TODAY });
    const oct = churnMonth(data, '2026-10', TODAY);
    assert.equal(d.tabs[0].rows.filter((r) => r.counted).length, oct.num);
    assert.equal(d.tabs[1].rows.length, oct.den);
    const f = drill(data, { kpi: 'fulfilment', month: '2026-10', today: TODAY });
    assert.equal(f.tabs[0].rows.filter((r) => r.kind === 'done').length, fulfilmentMonth(data, '2026-10', TODAY).num);
    assert.equal(f.tabs[0].rows.length, fulfilmentMonth(data, '2026-10', TODAY).den);
  });
  test('the dataset is the same every time it is built for the same day', () => {
    assert.deepEqual(card().tiles.map((t) => t.value), card().tiles.map((t) => t.value));
  });
});

describe('kpi service', () => {
  const quiet = { info() {}, warn() {}, error() {} };
  test('dev: scorecard defaults to the last closed month; refresh log is idempotent; manual reviews round-trip', async () => {
    const db = await openDb({});
    const kpi = createKpi({ db, config: loadConfig({ APP_ENV: 'development', L27_MODE: 'mock' }), log: quiet, now: () => NOW });
    const c = await kpi.scorecard();
    assert.equal(c.month, '2026-10');
    assert.equal(c.synthetic, true);
    await kpi.scorecard({ outage: 'google_stale' });
    await kpi.scorecard();
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kpi_refresh_log')).rows[0].n, 5);
    await assert.rejects(kpi.scorecard({ month: '2023-12' }), { status: 400 });
    await assert.rejects(kpi.scorecard({ month: '2026-11' }), { status: 400 });
    await assert.rejects(kpi.drill({ kpi: 'billing' }), { status: 400 });
    await kpi.saveManualReviews({ brand: 'urbanmop', month: '2026-10', entry: { new_reviews: 7, avg_rating: 4.6, alltime_avg: 4.7, alltime_count: 500 }, email: 'qa@example.com' });
    const after = (await kpi.scorecard()).tiles.find((t) => t.kpi === 'reviews');
    assert.equal(after.value, 7);
    assert.ok(after.badges.some((x) => /Manual entry/.test(x.text)));
    await assert.rejects(kpi.saveManualReviews({ month: '2026-10', entry: { new_reviews: -1, avg_rating: 9, alltime_avg: 4, alltime_count: 1 } }), { status: 400 });
    await kpi.clearManualReviews({ brand: 'urbanmop', month: '2026-10' });
    assert.notEqual((await kpi.scorecard()).tiles.find((t) => t.kpi === 'reviews').value, 7);
    await db.close();
  });
  test('production: nothing synthetic, every tile is No data, no manual entry, and only KPI_EMAILS get in', async () => {
    const db = await openDb({});
    const config = loadConfig({ APP_ENV: 'production', KPI_EMAILS: 'Boss@Example.com' });
    const kpi = createKpi({ db, config, log: quiet, now: () => NOW });
    const c = await kpi.scorecard();
    assert.equal(c.synthetic, false);
    assert.equal(c.outages, null);
    for (const t of c.tiles.filter((x) => x.kpi !== 'billing')) assert.deepEqual([t.state, t.value], ['no_data', null], t.kpi);
    // An outage preview asked for in production is ignored.
    assert.equal((await kpi.scorecard({ outage: 'google_stale' })).outage, null);
    await assert.rejects(kpi.saveManualReviews({ month: '2026-10', entry: { new_reviews: 1, avg_rating: 5, alltime_avg: 5, alltime_count: 1 } }), { status: 403 });
    assert.equal(canSeeKpi(config, 'boss@example.com'), true);
    assert.equal(canSeeKpi(config, 'someone@example.com'), false);
    assert.equal(canSeeKpi(loadConfig({ APP_ENV: 'staging' }), 'anyone@example.com'), true);
    await db.close();
  });
  test('connectors only read: each exposes pull and nothing that writes', () => {
    for (const c of createKpiConnectors({ synthetic: true })) assert.deepEqual(Object.keys(c).filter((k) => typeof c[k] === 'function'), ['pull']);
  });
  test('a source that throws is a missing source, not a crash and not a zero', async () => {
    const db = await openDb({});
    const connectors = createKpiConnectors({ synthetic: true });
    connectors[1].pull = async () => { throw new Error('Kustomer 503'); };
    const kpi = createKpi({ db, config: loadConfig({ APP_ENV: 'development', L27_MODE: 'mock' }), log: quiet, now: () => NOW, connectors });
    const t = (await kpi.scorecard()).tiles.find((x) => x.kpi === 'complaints');
    assert.deepEqual([t.state, t.value], ['no_data', null]);
    await db.close();
  });
});
