// One connector per source system. Every connector is read-only by construction: it exposes
// pull() and nothing else, so there is no code path that writes to Launch27, QuickBooks,
// Kustomer, Google or Gmail.
//
// pull() returns that source's slice of the normalized dataset the calc layer reads:
//   launch27 -> { bookings }          id, customer_id, customer, date, start, created_at, frequency,
//                                     completed, cleaner, checkin_at, rating (0 bad | 1 ok | 2 good),
//                                     rated_at, rating_comment, cancellation { at, reason, by, by_name }
//   kustomer -> { complaints }        id, customer_id, customer, booking_id, date, channel, summary
//   google   -> { reviews, reviewBaseline }
//   qbo      -> { qbo }               month, revenue, lines [{ account, category, amount }]
//   syft     -> { syft }              month, ocr_pct, received_at
// plus { refreshed_at, note }. Dates and times are local calendar strings.
//
// Development and QA: synthetic data (synthetic.js). Production: not connected until the
// production phase, so every tile reads "No data" rather than showing an invented number.
import { buildSyntheticDataset } from './synthetic.js';
import { KPI_SOURCES } from './config.js';

const NOT_CONNECTED = { refreshed_at: null, note: 'not connected yet' };

export function createKpiConnectors({ synthetic }) {
  let memo = null;
  const data = (opts) => {
    const key = `${opts.today}|${opts.outage || ''}`;
    if (memo?.key !== key) memo = { key, ds: buildSyntheticDataset(opts) };
    return memo.ds;
  };
  const slice = (source, pick) => ({
    key: source,
    label: KPI_SOURCES[source].label,
    mode: synthetic ? 'synthetic' : 'not_connected',
    async pull(opts) {
      if (!synthetic) return { ...NOT_CONNECTED };
      const ds = data(opts);
      return { ...ds.sources[source], ...pick(ds) };
    },
  });
  return [
    slice('launch27', (ds) => ({ bookings: ds.bookings })),
    slice('kustomer', (ds) => ({ complaints: ds.complaints })),
    slice('google', (ds) => ({ reviews: ds.reviews, reviewBaseline: ds.reviewBaseline })),
    slice('qbo', (ds) => ({ qbo: ds.ocr.qbo })),
    slice('syft', (ds) => ({ syft: ds.ocr.syft })),
  ];
}
