import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { indexDataset, isRecurring, isTest, isInstitutional, reasonCategory, churnBand, isOverCancel, cancellationCause, churnMonth, churnSegment, fulfilmentMonth, complaintsMonth, reviewsMonth, ocrMonth, fulfilmentRange, scorecard, drill, lastClosedMonth, sourceState, ocrStatus, fulfilmentStatus } from '../src/kpi/calc.js';
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
    assert.equal(outcome(r, 'Returner'), 'Excluded: came back (skipped or moved visit, recurring visits continued)');
    assert.equal(outcome(r, 'One Off Later'), 'Counted as churn');
    assert.match(outcome(r, 'Skipper'), /came back/);
    assert.equal(r.num, 1);
  });
  test('prepaid and pay-as-you-go are reported separately, and add up to the blended number', () => {
    const r = res([
      b(1, 'Prepaid Leaver', '2026-10-02', { frequency: 'Prepaid Biweekly' }), b(1, 'Prepaid Leaver', '2026-10-16', { frequency: 'Prepaid Biweekly', cancellation: cx('2026-10-10', 'Too expensive') }),
      b(2, 'Payg Leaver', '2026-10-02'), b(2, 'Payg Leaver', '2026-10-16', { cancellation: cx('2026-10-10', 'Moving away') }),
      b(3, 'Prepaid Stayer', '2026-10-05', { frequency: 'Prepaid Monthly' }), b(3, 'Prepaid Stayer', '2026-11-02', { frequency: 'Prepaid Monthly' }), b(3, 'Prepaid Stayer', '2026-11-30', { frequency: 'Prepaid Monthly' }),
      // On both kinds of plan in the month: kept under the first visit's plan, and flagged.
      b(4, 'Both Plans', '2026-10-05'), b(4, 'Both Plans', '2026-10-19', { frequency: 'Prepaid Biweekly' }), b(4, 'Both Plans', '2026-11-02', { frequency: 'Prepaid Biweekly' }), b(4, 'Both Plans', '2026-11-30', { frequency: 'Prepaid Biweekly' }),
    ]);
    assert.deepEqual(r.segments.prepaid, { den: 2, permanent: 1, provisional: 1, temporary: 0 });
    assert.deepEqual(r.segments.payg, { den: 12, permanent: 1, provisional: 1, temporary: 0 });
    assert.deepEqual([r.num, r.den], [2, 14]);
    assert.deepEqual(r.unclear, { mixed: 1, off_base: 0, moved: 0 });
    assert.deepEqual([churnSegment('Prepaid Biweekly'), churnSegment('Pre-paid monthly'), churnSegment('Biweekly - 10% off')], ['prepaid', 'prepaid', 'payg']);
  });
  test('temporary churn: back inside 90 days after more than 60 days between cleans; later than 90 is permanent', () => {
    const june = (extra) => churnMonth(ix([b(50, 'Steady', '2026-06-02'), ...extra]), '2026-06', TODAY);
    const left = (id, name) => [b(id, name, '2026-06-01'), b(id, name, '2026-06-15', { cancellation: cx('2026-06-10', 'Too expensive') })];
    const r = june([
      ...left(1, 'Back In August'), b(1, 'Back In August', '2026-08-20'),
      ...left(2, 'Back Too Late'), b(2, 'Back Too Late', '2026-09-20'),
      ...left(3, 'Skipped One'), b(3, 'Skipped One', '2026-06-29'),
    ]);
    assert.match(outcome(r, 'Back In August'), /^Excluded: temporary churn, came back after 71 days/);
    assert.equal(outcome(r, 'Back Too Late'), 'Counted as churn');
    assert.match(outcome(r, 'Skipped One'), /skipped or moved visit/);
    assert.deepEqual(r.segments.payg, { den: 4, permanent: 1, provisional: 0, temporary: 1 });
  });
  test('a prepaid plan that runs out with no renewal is churn, dated the last prepaid visit', () => {
    const P = { frequency: 'Prepaid Biweekly' };
    const june = churnMonth(ix([
      b(50, 'Steady', '2026-06-02'),
      b(1, 'Ran Out', '2026-06-01', P), b(1, 'Ran Out', '2026-06-15', P),
      b(2, 'Renewed', '2026-06-01', P), b(2, 'Renewed', '2026-06-15', P), b(2, 'Renewed', '2026-06-29', P), b(2, 'Renewed', '2026-07-13', P), b(2, 'Renewed', '2026-08-24', P), b(2, 'Renewed', '2026-10-05', P), b(2, 'Renewed', '2026-11-16', P),
      b(3, 'Renewed Late', '2026-06-01', P), b(3, 'Renewed Late', '2026-06-15', P), b(3, 'Renewed Late', '2026-08-25', P), b(3, 'Renewed Late', '2026-10-06', P), b(3, 'Renewed Late', '2026-11-17', P),
      b(4, 'Switched Plan', '2026-06-01', P), b(4, 'Switched Plan', '2026-06-15', P), b(4, 'Switched Plan', '2026-06-29'), b(4, 'Switched Plan', '2026-07-13'), b(4, 'Switched Plan', '2026-11-16'),
    ]), '2026-06', TODAY);
    const ev = (name) => june.events.filter((e) => e.customer === name);
    assert.deepEqual(ev('Ran Out').map((e) => [e.cancelled_on, e.outcome, e.reason]), [['2026-06-15', 'Counted as churn (prepaid plan ended)', 'Prepaid plan ended, not renewed']]);
    assert.equal(ev('Renewed').length, 0);
    assert.match(ev('Renewed Late')[0].outcome, /^Excluded: temporary churn, renewed after 71 days/);
    assert.equal(ev('Switched Plan').length, 0, 'moving to pay-as-you-go without a gap is not churn');
    assert.deepEqual(june.segments.prepaid, { den: 4, permanent: 1, provisional: 0, temporary: 1 });
    assert.equal(june.plan_ends, 1);
    // A plan that ended inside the last 90 days counts now and is marked provisional; one whose last visit is still ahead does not.
    const oct = res([b(1, 'Just Ended', '2026-10-02', P), b(1, 'Just Ended', '2026-10-16', P), b(2, 'Still Running', '2026-10-06', P), b(2, 'Still Running', '2026-11-24', P)]);
    assert.match(oct.events.find((e) => e.customer === 'Just Ended').outcome, /prepaid plan ended, inside the 90-day return window/);
    assert.deepEqual(oct.segments.prepaid, { den: 2, permanent: 1, provisional: 1, temporary: 0 });
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
  test('headline: completed ÷ on the books 48 hours ahead; late is still fulfilled', () => {
    const r = fulfilmentMonth(ix(rows()), '2026-10', TODAY);
    // On the books 48 h ahead: On Time, Exactly 30, Late 31 (completed); No Check-in, Cleaner Sick (ours); Vague (unclear).
    // Not in it: the client who cancelled a week ahead, and the booking made the day before.
    assert.deepEqual([r.num, r.den, r.value], [3, 6, 50]);
    assert.deepEqual([r.company, r.client, r.unclassified, r.late, r.added_late], [2, 0, 1, 1, 1]);
    assert.deepEqual(r.misses.map((m) => [m.kind, m.label, m.n]), [['company', 'Not completed (no check-in)', 1], ['company', 'Cleaner cancelled', 1], ['unclassified', 'Unclassified staff cancellation', 1]]);
    assert.ok(!r.rows.some((x) => x.customer === 'Simon Test'));
    assert.equal(r.rows.find((x) => x.customer === 'Late 31').result, 'Completed, arrived late (over 30 min)');
    assert.equal(r.rows.find((x) => x.customer === 'Exactly 30').late, false);
  });
  test('all scheduled: anything not completed is not fulfilled, whoever caused it', () => {
    const r = fulfilmentMonth(ix(rows()), '2026-10', TODAY).all;
    assert.deepEqual([r.num, r.den, r.value, r.company, r.client, r.unclassified], [4, 8, 50, 2, 1, 1]);
  });
  test('a client cancelling inside 48 hours is not fulfilled, and is client-related', () => {
    const r = fulfilmentMonth(ix([b(1, 'Done', '2026-10-05'), b(2, 'Last Minute', '2026-10-05', { cancellation: { at: '2026-10-04T20:00', reason: 'Sick', by: 'customer' } })]), '2026-10', TODAY);
    assert.deepEqual([r.num, r.den, r.client, r.company], [1, 2, 1, 0]);
  });
  test('status against the 98.5% target: on track, within 5% below, beyond', () => {
    assert.deepEqual([99, 98.5, 98.4, 93.6, 93.5].map((v) => fulfilmentStatus(v).label), ['On track', 'On track', 'Warning', 'Warning', 'Off track']);
  });
  test('late threshold is configurable', () => {
    assert.equal(fulfilmentMonth(ix(rows()), '2026-10', TODAY, { ...KPI_RULES, lateMinutes: 45 }).late, 0);
    assert.equal(fulfilmentMonth(ix(rows()), '2026-10', TODAY, { ...KPI_RULES, lateMinutes: 20 }).late, 2);
  });
  test('weekly split', () => {
    const r = fulfilmentMonth(ix(rows()), '2026-10', TODAY);
    assert.equal(r.weeks[0].from, '2026-10-01');
    assert.equal(r.weeks[0].to, '2026-10-04');
    assert.equal(r.weeks[1].den, 6);
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
  test('status against the 63–68% target: on track, within 5% above, beyond', () => {
    assert.deepEqual([60, 68, 68.1, 71.4, 71.5].map((v) => ocrStatus(v).label), ['On track', 'On track', 'Warning', 'Warning', 'Off track']);
  });
  test('Provisional until the 10th of the following month, then Final', () => {
    assert.equal(ocrMonth(data([]), '2026-10', '2026-11-09').status, 'Provisional');
    assert.equal(ocrMonth(data([]), '2026-10', '2026-11-10').status, 'Final');
  });
  test('no QuickBooks month: the Syft report stated figure is shown, marked as such; neither source is No data', () => {
    const r = ocrMonth(data([{ month: '2026-09', ocr_pct: 58, income: 200_000, file: 'UM Canada Management Report September 2026.pdf', received_at: '2026-10-09T12:00:00Z' }]), '2026-09', TODAY);
    assert.deepEqual([r.state, r.basis, r.value, r.den, r.num, r.flagged, r.diff], ['ok', 'syft', 58, 200_000, 116_000, false, null]);
    assert.equal(ocrMonth(data([]), '2026-10', TODAY).basis, 'qbo');
    const none = ocrMonth(data([]), '2026-08', TODAY);
    assert.deepEqual([none.state, none.value], ['no_data', null]);
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
    // The same two reference lines, in the same words, on every tile.
    assert.deepEqual(c.tiles.map((t) => t.target), ['63–68%', 'under 6.8%', '98.5% or higher', null, null, null]);
    for (const t of c.tiles.filter((y) => y.kpi !== 'billing')) assert.ok(t.last12, t.kpi);
    assert.ok(!c.tiles.some((t) => t.details.some((d) => /north star|baseline|^target$/i.test(d.label))));
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
  test('a missing source shows no value (never a zero); a stale one keeps its figures and is marked', () => {
    const stale = card('launch27_stale');
    const fresh = card(null);
    for (const k of ['churn', 'fulfilment', 'complaints', 'reviews']) assert.deepEqual([tile(stale, k).state, tile(stale, k).stale, tile(stale, k).value], ['ok', true, tile(fresh, k).value], k);
    assert.deepEqual([tile(stale, 'ocr').state, tile(stale, 'ocr').stale, tile(fresh, 'churn').stale], ['ok', undefined, undefined]);
    const noKustomer = card('kustomer_missing');
    assert.deepEqual([tile(noKustomer, 'complaints').state, tile(noKustomer, 'complaints').value], ['no_data', null]);
    assert.equal(tile(noKustomer, 'churn').state, 'ok');
    // QuickBooks missing: the Syft report's figure stands in, and says so. Both missing: No data.
    const noQbo = tile(card('qbo_missing'), 'ocr');
    assert.equal(noQbo.state, 'ok');
    assert.ok(noQbo.badges.some((b) => /Syft report.*no cross-check/.test(b.text)));
    assert.ok(noQbo.badges.some((b) => /Whole company/.test(b.text)));
    const neither = indexDataset({ ...buildSyntheticDataset({ today: TODAY, now: NOW, outage: 'qbo_missing' }), ocr: { qbo: [], syft: [] } });
    const t = scorecard(neither, { brand, month: '2026-10', now: NOW, today: TODAY }).tiles.find((y) => y.kpi === 'ocr');
    assert.deepEqual([t.state, t.value], ['no_data', null]);
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
    assert.equal(f.tabs[0].rows.filter((r) => r.kind === 'done' && r.on_books_48h).length, fulfilmentMonth(data, '2026-10', TODAY).num);
    assert.equal(f.tabs[0].rows.filter((r) => r.on_books_48h).length, fulfilmentMonth(data, '2026-10', TODAY).den);
    assert.equal(f.tabs[0].rows.length, fulfilmentMonth(data, '2026-10', TODAY).all.den);
  });
  test('the dataset is the same every time it is built for the same day', () => {
    assert.deepEqual(card().tiles.map((t) => t.value), card().tiles.map((t) => t.value));
  });
});

describe('custom date range and month in progress', () => {
  const brand = KPI_BRANDS[0];
  const steady = () => Array.from({ length: 10 }, (_, i) => [b(100 + i, `Steady ${i}`, '2026-11-03'), b(100 + i, `Steady ${i}`, '2026-11-17'), b(100 + i, `Steady ${i}`, '2026-12-01')]).flat();
  test('churn over exact dates: events inside the range ÷ clients with a recurring visit in the 31 days from its start', () => {
    const data = ix([
      ...steady(),
      b(1, 'In Range', '2026-11-02'), b(1, 'In Range', '2026-11-16', { cancellation: cx('2026-11-10', 'Moving out of Ottawa') }),
      b(2, 'After Range', '2026-11-04'), b(2, 'After Range', '2026-11-25', { cancellation: cx('2026-11-20', 'Too expensive') }),
      b(3, 'Monthly, Next Visit Late', '2026-11-28', { frequency: 'Monthly - 5% off' }),
      b(4, 'Starts Too Late', '2026-12-05'),
    ]);
    const r = churnMonth(data, '2026-11', '2026-11-25', KPI_RULES, { from: '2026-11-01', to: '2026-11-19' });
    assert.deepEqual([r.num, r.den], [1, 13]); // ten steady + In Range + After Range + the monthly client; not the December starter
    assert.deepEqual(r.events.map((e) => e.customer), ['In Range']);
    // The whole month counts both cancellations.
    assert.equal(churnMonth(data, '2026-11', '2026-12-05').num, 2);
  });
  test('complaints, reviews and fulfilment follow the same dates', () => {
    const rated = b(1, 'Rated Early', '2026-10-04', { rating: 0, rated_at: '2026-10-05' });
    const ratedLate = b(2, 'Rated Late', '2026-10-25', { rating: 0, rated_at: '2026-10-26' });
    const visits = Array.from({ length: 20 }, (_, i) => b(300 + i, `V ${i}`, i < 10 ? '2026-10-06' : '2026-10-22'));
    const reviews = [{ id: 1, date: '2026-10-03', rating: 5 }, { id: 2, date: '2026-10-09', rating: 3 }, { id: 3, date: '2026-10-20', rating: 5 }];
    const data = ix([rated, ratedLate, ...visits], { reviews });
    const w = { from: '2026-10-01', to: '2026-10-15' };
    const c = complaintsMonth(data, '2026-10', TODAY, KPI_RULES, w);
    assert.deepEqual([c.num, c.den], [1, 11]);
    const r = reviewsMonth(data, '2026-10', KPI_RULES, w);
    assert.deepEqual([r.value, r.avg, r.alltime_count], [2, 4, 102]);
  });
  test('scorecard in range mode: label, comparison with the days before, OCR by month only, no churn band', () => {
    const data = indexDataset(buildSyntheticDataset({ today: TODAY, now: NOW }));
    const c = scorecard(data, { brand, mode: 'range', range: { from: '2026-11-01', to: '2026-11-18' }, now: NOW, today: TODAY });
    const tile = (k) => c.tiles.find((t) => t.kpi === k);
    assert.equal(c.period, 'Nov 1, 2026 – Nov 18, 2026');
    assert.equal(c.mode, 'range');
    assert.deepEqual([tile('ocr').state, tile('ocr').value], ['no_data', null]);
    assert.match(tile('ocr').note, /by month only/);
    assert.equal(tile('churn').state, 'ok');
    assert.equal(tile('churn').status, null);
    assert.ok(tile('churn').badges.some((x) => /do not apply to a partial period/.test(x.text)));
    assert.equal(tile('fulfilment').delta.versus, 'the 18 days before');
    assert.equal(fulfilmentRange(data, '2026-11-01', '2026-11-18', TODAY).num, Number(tile('fulfilment').details[0].value.split(' ÷ ')[0].replace(/,/g, '')));
    const d = drill(data, { kpi: 'churn', mode: 'range', range: { from: '2026-11-01', to: '2026-11-18' }, today: TODAY });
    assert.ok(d.tabs[0].rows.every((r) => r.cancelled_on >= '2026-11-01' && r.cancelled_on <= '2026-11-18'));
    assert.match(d.title, /Nov 1, 2026 – Nov 18, 2026/);
  });
  test('the month in progress is shown to date, marked, and its last-12-months figure uses complete months', () => {
    const data = indexDataset(buildSyntheticDataset({ today: TODAY, now: NOW }));
    const c = scorecard(data, { brand, month: '2026-11', now: NOW, today: TODAY });
    assert.equal(c.period, 'Nov 2026 to date');
    const churn = c.tiles.find((t) => t.kpi === 'churn');
    assert.ok(churn.badges.some((x) => /Month in progress/.test(x.text)));
    assert.equal(churn.status, null);
    assert.equal(churn.last12, scorecard(data, { brand, month: '2026-10', now: NOW, today: TODAY }).tiles.find((t) => t.kpi === 'churn').last12);
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
    // The month in progress can be picked; a future month cannot.
    assert.equal((await kpi.scorecard({ month: '2026-11' })).period, 'Nov 2026 to date');
    await assert.rejects(kpi.scorecard({ month: '2026-12' }), { status: 400 });
    // Custom dates: validated, and never in the future.
    assert.equal((await kpi.scorecard({ mode: 'range', from: '2026-11-01', to: '2026-11-19' })).period, 'Nov 1, 2026 – Nov 19, 2026');
    for (const bad of [{ from: '2026-11-10', to: '2026-11-01' }, { from: '2026-11-01', to: '2026-11-20' }, { from: '2023-12-31', to: '2026-11-01' }, { from: '2026-02-30', to: '2026-11-01' }, { from: '2026-11-01' }]) await assert.rejects(kpi.scorecard({ mode: 'range', ...bad }), { status: 400 });
    assert.ok((await kpi.drill({ kpi: 'fulfilment', mode: 'range', from: '2026-11-01', to: '2026-11-19' })).tabs[0].rows.length > 0);
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

describe('kpi live connectors (production path), run against the synthetic Launch27', async () => {
  const { createMockLaunch27 } = await import('../src/mock/launch27.js');
  const { createSyncBearer } = await import('../src/inbox/lookup.js');
  const { createLaunch27Kpi, createKustomerKpi, createLiveKpiConnectors, normalizeBooking, localStamp } = await import('../src/kpi/live.js');
  const { createSyftKpi, parseSyftReport } = await import('../src/kpi/syft.js');
  const { addDays: plusDays, localDate } = await import('../src/schedule/rules.js');
  const quiet = { info() {}, warn() {}, error() {} };
  const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
  const brand = KPI_BRANDS[0];
  // Only the last three months, to keep the test quick.
  const first = plusDays(localDate(Date.now()), -90).slice(0, 7);
  const rules = { ...KPI_RULES, firstMonth: first };
  const setup = async () => {
    const calls = [];
    const mock = createMockLaunch27({ password: 'demo' });
    const fetchImpl = (url, init = {}) => {
      calls.push({ method: init.method || 'GET', path: new URL(url).pathname });
      return mock(url, init);
    };
    const db = await openDb({});
    const l27 = createLaunch27Kpi({ db, config, fetchImpl, syncBearer: createSyncBearer({ config, fetchImpl }), brand, log: quiet, rules });
    return { calls, db, l27, fetchImpl };
  };

  test('times become Toronto calendar strings', () => {
    assert.equal(localStamp('2026-10-05T13:00:00Z'), '2026-10-05T09:00');
    assert.equal(localStamp('2026-01-05T03:30:00Z'), '2026-01-04T22:30');
    assert.equal(localStamp(null), null);
  });
  test('a Launch27 booking is normalized; who cancelled comes from the name on the cancellation', () => {
    const base = { id: 7, user: { id: 3, first_name: 'Amelia', last_name: 'Roy' }, service_date: '2026-10-05T13:00:00Z', created_at: '2026-09-01T15:00:00Z', frequency: { name: 'Biweekly - 10% off' }, teams: [{ id: 1, title: ' Rosa M. ' }], location: { name: 'Ottawa' }, active: true, completed: true };
    const done = normalizeBooking(base, { teams: [{ id: 1, time_tracking: { checkin_at: '2026-10-05T13:40:00Z' } }] }, { feedback: { rating: 0, rated_at: '2026-10-06T14:00:00Z', comment: 'private text' } });
    assert.deepEqual([done.customer, done.date, done.start, done.created_at, done.completed, done.cleaner, done.checkin_at, done.rating, done.rated_at, done.cancellation], ['Amelia Roy', '2026-10-05', '2026-10-05T09:00', '2026-09-01T11:00', true, 'Rosa M.', '2026-10-05T09:40', 0, '2026-10-06', null]);
    assert.equal(done.rating_comment, null); // review text is not copied out of Launch27
    const byClient = normalizeBooking({ ...base, active: false, completed: false, cancellation: { date: '2026-10-03T18:00:00Z', reason: 'Moving', cancelled_by: { name: 'amelia  roy' } } });
    assert.deepEqual([byClient.completed, byClient.cancellation.by, byClient.cancellation.at, byClient.cancellation.reason], [false, 'customer', '2026-10-03T14:00', 'Moving']);
    assert.equal(normalizeBooking({ ...base, active: false, cancellation: { date: '2026-10-03T18:00:00Z', reason: 'Cleaner sick', cancelled_by: { name: 'Kimmy' } } }).cancellation.by, 'staff');
  });
  test('refresh only logs in and reads; it is idempotent; the brand keeps only its own location', async () => {
    const { calls, db, l27 } = await setup();
    assert.equal((await l27.pull()).refreshed_at, null);
    const one = await l27.job.start();
    assert.ok(one.bookings > 100 && one.full);
    const got = await l27.pull();
    assert.ok(got.refreshed_at);
    assert.ok(got.bookings.every((b) => b.location === 'Ottawa' && b.date && b.start && b.frequency !== undefined));
    assert.ok(got.bookings.some((b) => b.completed && b.checkin_at));
    const two = await l27.job.start({ full: true });
    assert.equal(two.bookings, one.bookings);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kpi_snapshots')).rows[0].n, 1);
    assert.deepEqual((await db.query("SELECT status FROM kpi_refresh_log WHERE source = 'launch27'")).rows, [{ status: 'ok' }]);
    // Read-only: one kind of POST (the login), everything else GET.
    assert.deepEqual([...new Set(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`))], ['POST /latest/login']);
    assert.ok(calls.filter((c) => c.method === 'GET').every((c) => c.path.startsWith('/v1/staff/bookings')));
    await db.close();
  });
  test('with no sync login, the daily job stays quiet and the signed-in login can refresh', async () => {
    const { db, fetchImpl } = await setup();
    const live = { ...config, l27Mode: 'live', l27SyncEmail: null, l27SyncPassword: null };
    const l27 = createLaunch27Kpi({ db, config: live, fetchImpl, syncBearer: async () => null, brand, log: quiet, rules });
    await l27.job.maybeRun();
    assert.equal(l27.job.running(), false);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kpi_refresh_log')).rows[0].n, 0);
    const mine = await createSyncBearer({ config, fetchImpl })();
    const done = await l27.job.start({ bearer: mine });
    assert.ok(done.bookings > 100);
    await db.close();
  });
  test('opening the scorecard refreshes Launch27 by itself on the viewer login, then leaves it alone', async () => {
    const { db, fetchImpl } = await setup();
    const live = { ...config, production: true, l27Mode: 'live', l27SyncEmail: null, l27SyncPassword: null };
    const connectors = createLiveKpiConnectors({ db, config: live, fetchImpl, syncBearer: async () => null, brand, log: quiet });
    const kpi = createKpi({ db, config: live, log: quiet, connectors });
    // Nobody signed in to Launch27 on this request: nothing starts.
    assert.equal((await kpi.scorecard()).refresh.running, false);
    const mine = await createSyncBearer({ config, fetchImpl })();
    assert.equal((await kpi.scorecard({ bearer: mine })).refresh.running, true);
    await connectors[0].job.start();
    const after = await kpi.scorecard({ bearer: mine });
    assert.equal(after.refresh.running, false);
    assert.equal(after.sources.find((x) => x.key === 'launch27').state, 'ok');
    assert.equal(after.tiles.find((t) => t.kpi === 'fulfilment').state, 'ok');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM kpi_refresh_log WHERE source = 'launch27'")).rows[0].n, 1);
    await db.close();
  });
  test('a failed refresh keeps the previous snapshot and is logged', async () => {
    const { db, fetchImpl } = await setup();
    let broken = false;
    const flaky = (url, init) => (broken && !String(url).includes('/login') ? Promise.resolve(new Response('{}', { status: 503 })) : fetchImpl(url, init));
    const l27 = createLaunch27Kpi({ db, config, fetchImpl: flaky, syncBearer: createSyncBearer({ config, fetchImpl: flaky }), brand, log: quiet, rules });
    const ok = await l27.job.start();
    const before = (await l27.pull()).refreshed_at;
    broken = true;
    assert.equal(await l27.job.start({ full: true }), null);
    const after = await l27.pull();
    assert.equal(after.refreshed_at, before);
    assert.equal(after.bookings.length, ok.bookings);
    assert.equal((await db.query("SELECT status FROM kpi_refresh_log WHERE source = 'launch27'")).rows[0].status, 'failed');
    await db.close();
  });
  test('Kustomer complaints come from the complaint tables, with the periods the playbook has read', async () => {
    const db = await openDb({});
    const k = createKustomerKpi({ db, brand });
    assert.equal((await k.pull()).refreshed_at, null);
    // A run that is still going or failed does not count; finished ones do, and touching windows join up.
    await db.query(`INSERT INTO complaint_runs (window_from, window_to, status, finished_at) VALUES
      ('2026-08-01','2026-08-31','done','2026-11-18T10:00:00Z'), ('2026-09-01','2026-10-31','partial','2026-11-19T10:00:00Z'),
      ('2026-01-01','2026-01-31','done','2026-11-17T10:00:00Z'), ('2026-11-01','2026-11-19','running',NULL), ('2026-06-01','2026-06-30','failed','2026-11-19T11:00:00Z')`);
    await db.query(`INSERT INTO complaint_cases (brand, source, source_id, customer_name, customer_email, l27_customer_id, l27_booking_id, opened_at, channel, category, excluded_at) VALUES
      ('residential','kustomer','a','Amelia Roy','a@example.com',3,7,'2026-10-06T15:00:00Z','email','Quality',NULL),
      ('residential','kustomer','b','No Match','b@example.com',NULL,NULL,'2026-10-07T02:00:00Z','voice','Late',NULL),
      ('commercial','kustomer','c','Other Brand','c@example.com',9,NULL,'2026-10-07T15:00:00Z','email','Quality',NULL),
      ('residential','launch27_rating','d','A Rating','d@example.com',4,8,'2026-10-07T15:00:00Z','review','Quality',NULL),
      ('residential','kustomer','e','Marked Not A Complaint','e@example.com',5,NULL,'2026-10-08T15:00:00Z','email','Quality',now())`);
    const got = await k.pull();
    assert.equal(got.refreshed_at, '2026-11-19T10:00:00.000Z');
    assert.deepEqual(got.complaintCoverage, [{ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-08-01', to: '2026-10-31' }]);
    assert.deepEqual(got.complaints.map((c) => [c.customer, c.customer_id, c.booking_id, c.date]), [['Amelia Roy', 3, 7, '2026-10-06'], ['No Match', 'email:b@example.com', null, '2026-10-06']]);
    await db.close();
  });
  test('a month the playbook has not read is No data, not zero complaints', () => {
    const visits = [b(1, 'V', '2026-07-10'), b(1, 'V', '2026-08-10')];
    const data = ix(visits, { complaintCoverage: [{ from: '2026-08-01', to: '2026-10-31' }] });
    assert.deepEqual([complaintsMonth(data, '2026-07', TODAY).state, complaintsMonth(data, '2026-07', TODAY).value], ['no_data', null]);
    assert.deepEqual([complaintsMonth(data, '2026-08', TODAY).state, complaintsMonth(data, '2026-08', TODAY).value], ['ok', 0]);
    // The current month is covered when the read reaches yesterday.
    const now2 = ix([b(1, 'V', '2026-11-10')], { complaintCoverage: [{ from: '2026-11-01', to: '2026-11-18' }] });
    assert.equal(complaintsMonth(now2, '2026-11', TODAY).state, 'ok');
  });
  test('Google export: dated, not stale, labelled, and months after it are No data', async () => {
    const { createGoogleExportKpi } = await import('../src/kpi/live.js');
    const load = () => ({ exported_on: '2026-11-17', reviews_to: '2026-11-12', reviews: [['2025-01-05', 5], ['2026-10-03', 5], ['2026-10-09', 4], ['2026-10-20', 3], ['2026-11-12', 1]] });
    const got = await createGoogleExportKpi({ brand, load }).pull();
    assert.deepEqual([got.static, got.reviews.length, got.reviewsExport.reviews_to, got.reviews[0].reviewer], [true, 5, '2026-11-12', '']);
    assert.equal((await createGoogleExportKpi({ brand, load: () => null }).pull()).refreshed_at, null);
    // The export is weeks old but is not "stale"; Launch27 is fresh here.
    const later = Date.parse('2026-12-20T15:00:00Z');
    const fresh = new Date(later - 3_600_000).toISOString();
    const visits = Array.from({ length: 150 }, (_, i) => b(900 + i, `V ${i}`, '2026-10-12'));
    const data = indexDataset({ sources: { launch27: { refreshed_at: fresh }, google: { refreshed_at: got.refreshed_at, static: true } }, bookings: visits, complaints: [], reviews: got.reviews, reviewBaseline: got.reviewBaseline, reviewsExport: got.reviewsExport, ocr: { qbo: [], syft: [] }, manualReviews: {} });
    const oct = reviewsMonth(data, '2026-10');
    assert.deepEqual([oct.value, oct.avg, oct.alltime_count, oct.per100, oct.partial], [3, 4, 4, 2, false]);
    assert.equal(reviewsMonth(data, '2026-11').partial, true);
    assert.deepEqual([reviewsMonth(data, '2026-12').state, reviewsMonth(data, '2026-12').value], ['no_data', null]);
    const tile = scorecard(data, { brand, month: '2026-10', now: later, today: '2026-12-20' }).tiles.find((t) => t.kpi === 'reviews');
    assert.deepEqual([tile.state, tile.value], ['ok', 3]);
    assert.ok(tile.badges.some((x) => /Google export dated 2026-11-17: not live/.test(x.text)));
    // The real file in the repository loads, and holds dates and ratings only.
    const real = await createGoogleExportKpi({ brand }).pull();
    assert.ok(real.reviews.length > 500 && real.reviews.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.rating >= 1 && r.rating <= 5 && r.reviewer === '' && r.comment === ''));
  });
  test('Syft report: the stated Operational Cost Ratio and Total Income are read from the scorecard page', () => {
    // Invented figures in the layout of the report's Financial Health Scorecard page.
    const page = ['Financial Health Scorecard', '01 August 2026 - 31 August 2026 vs 01 July 2026 - 31 July 2026', 'Aug 2026  Jul 2026  Variance  Variance (%)', 'Revenue', 'Total Income  $100,000  $95,000  $5,000  5%', 'Gross profit margin  40.0%  41.0%  -1.0%  -2.4%', 'Service', 'Operational Cost Ratio  61.5%  60.2%  1.3%  2.2%', 'A/R Ratio  20.0%  19.0%  1.0%  5.3%'];
    assert.deepEqual(parseSyftReport(page), { month: '2026-08', ocr_pct: 61.5, income: 100000, prev: { month: '2026-07', ocr_pct: 60.2, income: 95000 } });
    assert.equal(parseSyftReport(['Income Statement', 'Total Income  $1']), null);
    assert.equal(parseSyftReport(['Aug 2026  Jul 2026  Variance  Variance (%)', 'Operational Cost Ratio  n/a  n/a']), null);
  });
  test('Syft connector: reads each report email once, a revision wins, files for other brands are ignored, only GETs', async () => {
    const db = await openDb({});
    const calls = [];
    const pdf = (name, id) => ({ filename: name, body: { attachmentId: id } });
    const mail = {
      m1: { internalDate: String(Date.parse('2026-09-11T14:00:00Z')), payload: { parts: [pdf('Luxoclean Management Report August 2026.pdf', 'lux'), pdf('UM Canada Management Report August 2026.pdf', 'aug-v1')] } },
      m2: { internalDate: String(Date.parse('2026-09-15T14:00:00Z')), payload: { parts: [pdf('UM Canada Management Report August 2026.pdf', 'aug-v2')] } },
      m3: { internalDate: String(Date.parse('2026-09-12T14:00:00Z')), payload: { parts: [{ filename: 'notes.docx', body: { attachmentId: 'x' } }] } },
      // Earlier months used other file names; one PDF with a matching name is another company's.
      m4: { internalDate: String(Date.parse('2026-05-11T14:00:00Z')), payload: { parts: [pdf('UrbanMop April Management Report V1.pdf', 'apr'), pdf('UrbanMop Monthly Report -Other.pdf', 'other-co')] } },
      // September's report restates August in its previous-month column; received last, it wins for August.
      m6: { internalDate: String(Date.parse('2026-10-10T14:00:00Z')), payload: { parts: [pdf('UM Canada Management Report September 2026.pdf', 'sep')] } },
      // The US company's report: similar name and layout, must never land on this brand.
      m5: { internalDate: String(Date.parse('2026-09-20T14:00:00Z')), payload: { parts: [pdf('UrbanMop US Syft Report - August 2026 (Draft).pdf', 'us-name'), pdf('UrbanMop Syft Report - August 2026.pdf', 'us-cover')] } },
    };
    const reports = { 'aug-v1': ['UrbanMop Inc.', 'Aug 2026  Jul 2026  Variance  Variance (%)', 'Total Income  $100,000  $95,000', 'Operational Cost Ratio  61.5%  60.2%'], apr: ['UM Canada Monthly Report', 'Apr 2026  Mar 2026  Variance  Variance (%)', 'Total Income  $90,000  $88,000', 'Operational Cost Ratio  59.0%  58.5%'], sep: ['UrbanMop Inc.', 'Sep 2026  Aug 2026  Variance  Variance (%)', 'Total Income  $102,000  $101,500', 'Operational Cost Ratio  60.0%  63.5%'], 'us-cover': ['UrbanMop US Monthly Report', 'Aug 2026  Jul 2026  Variance  Variance (%)', 'Operational Cost Ratio  30.0%  31.0%'], 'other-co': ['Some Other Co.', 'Apr 2026  Mar 2026  Variance  Variance (%)', 'Operational Cost Ratio  10.0%  11.0%'], 'aug-v2': ['UrbanMop Inc.', 'Aug 2026  Jul 2026  Variance  Variance (%)', 'Total Income  $101,000  $95,000', 'Operational Cost Ratio  62.0%  60.2%'] };
    const gmail = {
      search: async (account, q) => (calls.push(['search', account, q]), { ids: Object.keys(mail), next: null }),
      message: async (account, id) => (calls.push(['message', id]), mail[id]),
      attachment: async (account, id, att) => (calls.push(['attachment', att]), { data: Buffer.from(att).toString('base64url') }),
    };
    const syft = createSyftKpi({ db, gmail, mailbox: 'books@example.com', brand, log: quiet, now: () => NOW, readPdf: async (bytes) => reports[bytes.toString()] });
    assert.equal((await syft.pull()).refreshed_at, null);
    assert.deepEqual(await syft.job.start(), { months: 5, read: 4 });
    const got = (await syft.pull()).syft;
    assert.deepEqual(got.map((r) => [r.month, r.ocr_pct, r.income, !!r.restated]), [['2026-03', 58.5, 88000, true], ['2026-04', 59, 90000, false], ['2026-07', 60.2, 95000, true], ['2026-08', 63.5, 101500, true], ['2026-09', 60, 102000, false]]);
    assert.ok(!calls.some((c) => c[1] === 'lux'));
    assert.ok(!calls.some((c) => c[1] === 'us-name'));
    assert.equal(calls[0][1], 'books@example.com');
    // Second run: nothing is downloaded again.
    const before = calls.length;
    assert.deepEqual(await syft.job.start(), { months: 5, read: 0 });
    assert.equal(calls.slice(before).filter((c) => c[0] !== 'search').length, 0);
    assert.deepEqual((await db.query("SELECT status, row_count FROM kpi_refresh_log WHERE source = 'syft'")).rows, [{ status: 'ok', row_count: 5 }]);
    // On the scorecard: OCR comes from the report, marked as Syft with no cross-check.
    const kpi = createKpi({ db, config: { ...config, production: true }, log: quiet, now: () => NOW, connectors: [syft] });
    const tile = (await kpi.scorecard({ month: '2026-08' })).tiles.find((t) => t.kpi === 'ocr');
    assert.deepEqual([tile.state, tile.value, tile.status.label], ['ok', 63.5, 'On track']);
    assert.ok(tile.badges.some((x) => /Syft report.*QuickBooks is not connected/.test(x.text)));
    await db.close();
  });
  test('scorecard on live connectors: Launch27 KPIs have numbers, unconnected sources say No data', async () => {
    const { db, fetchImpl } = await setup();
    const connectors = createLiveKpiConnectors({ db, config, fetchImpl, syncBearer: createSyncBearer({ config, fetchImpl }), brand, log: quiet });
    const kpi = createKpi({ db, config: { ...config, production: true }, log: quiet, connectors });
    const before = await kpi.scorecard();
    assert.ok(before.tiles.filter((t) => t.kpi !== 'billing').every((t) => t.state === 'no_data' && t.value === null));
    assert.deepEqual(before.refresh, { available: true, running: false });
    kpi.refresh();
    await connectors[0].job.start();
    const c = await kpi.scorecard();
    const tile = (k) => c.tiles.find((t) => t.kpi === k);
    assert.equal(c.synthetic, false);
    assert.deepEqual([tile('churn').state, tile('fulfilment').state], ['ok', 'ok']);
    assert.ok(tile('fulfilment').value > 50);
    for (const k of ['ocr', 'complaints']) assert.deepEqual([tile(k).state, tile(k).value], ['no_data', null], k);
    // Google reviews come from the export in the repository.
    assert.equal(tile('reviews').state, 'ok');
    const rows = await kpi.drill({ kpi: 'fulfilment' });
    assert.ok(rows.tabs[0].rows.length > 0);
    await db.close();
  });
});
