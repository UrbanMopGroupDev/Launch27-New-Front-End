# KPI scorecard

**Reports → KPI scorecard** (`/reports/kpi`) is the monthly scorecard for UrbanMop (Ottawa
Residential). It is read-only: it never writes to Launch27, QuickBooks, Kustomer, Google or
Gmail, and it has no "edit data" controls.

**Status: phase 1 (development and QA, synthetic data).** Production shows every tile as
"No data" until the live connectors are built and signed off.

## Where the code is

| Part | Code |
| --- | --- |
| Brands, rule lists, thresholds | `server/src/kpi/config.js` |
| Every formula and exclusion rule | `server/src/kpi/calc.js` (pure; tests in `server/test/kpi.test.js`) |
| One read-only connector per source | `server/src/kpi/connectors.js` |
| Synthetic data for dev and QA | `server/src/kpi/synthetic.js` |
| Service and API (`/api/kpi/*`) | `server/src/kpi/service.js`, routes at the end of `server/src/inbox/api.js` |
| Page | `web/src/pages/KpiScorecard.tsx`, `web/src/kpi/api.ts` |
| Tables | `server/migrations/0029_kpi.sql` (`kpi_refresh_log`, `kpi_manual_reviews`) |

## Definitions

Every tile shows its value, period, source, last refresh and an "i" button with the formula.
If a source is missing or has not refreshed in 48 hours, the tile says "No data" or "Stale"
and shows no number. A month with no data is a gap in the trend, never a zero.

| KPI | Formula | Sources |
| --- | --- | --- |
| Operational Cost Ratio | Operational delivery cost ÷ revenue. Included: cleaner wages (contractor + employee), payroll taxes / EI / CPP / workers' comp on cleaners, supplies, field vehicle costs, ops/office staff, ops software, recruitment ads. Excluded: office rent, general business insurance. Syft's figure is shown beside it, flagged when they differ by more than 1.0 percentage point. Provisional until the 10th of the following month. Status against the 63–68% target: On track at or under 68%, Warning within 5% above, Off track beyond | QuickBooks Online (source of truth), Syft report |
| Recurring client churn | Permanent churn events in the calendar month ÷ active recurring clients at the start of the month. Bands: ≤7% Excellent, 7–10% Healthy, 10–12% Elevated, over 12% High. North Star under 6.8%; the tile also shows the last-12-months baseline | Launch27 |
| Service fulfilment | Bookings completed ÷ bookings on the books 48 hours before the visit (the ones we could have fulfilled); the same ratio over all scheduled bookings is shown beside it. A completed visit is fulfilled even when we arrived late (late arrivals over 30 minutes are counted separately). Anything not completed is not fulfilled, split into ours, client-related and unclear. Monthly and by week | Launch27 |
| Complaint rate | Complaints ÷ completed visits × 100. Complaint = Kustomer complaint object or Launch27 bottom rating, the same visit counted once. "Saved" = still booking 60+ days later | Kustomer, Launch27 |
| Google reviews | New reviews, average rating (month and all time), reviews per 100 completed visits | Google Business Profile, Launch27 |
| Billing cash conversion | Not built. Placeholder tile | — |

Churn rules, in the order they are applied to each cancellation in the month:

1. Test entry (listed names, or the word "test" in the name or reason): out.
2. Institutional client (carefor, owcs, bruyere, homemaking, mft, metis, digirealty, spark lifecare, corretto): out.
3. Not recurring (frequency has no weekly / biweekly / triweekly / monthly / prepaid, or is a one-time): out.
4. Reason is a LuxoClean transfer or an admin error: out.
   Temporary reasons (travel, hold/pause, renovation, Airbnb, postpartum): out if the client is back
   on a recurring plan within 90 days (shown as back within 30, 60 or 90); counted as churn in the
   cancellation month once 90 days pass with no return; pending, and not counted, until then.
5. The client has a later active recurring booking ("came back"): out.
6. A second event for the same client in the month: out.

Test and institutional clients are also left out of the base. The event is dated by the
cancellation date, and the last cleaner is the one on the client's last completed visit.

## Refresh schedule

Phase 1: synthetic data is generated in memory, the same for everyone on a given day. Each
load writes one row per source per day to `kpi_refresh_log` (updated in place, so repeats are
harmless). Planned for production: daily for churn, fulfilment, complaints and reviews; OCR
monthly once Syft arrives and QuickBooks closes.

## Who sees it

Dev and QA: everyone who can sign in. Production: only the logins in `KPI_EMAILS`
(comma-separated; empty means nobody), because it carries financial figures.

## Dev and QA extras

- **Preview a source outage** (Sources card): shows how tiles behave when a source is stale
  or not connected.
- **Enter Google reviews by hand**: a manual monthly entry while the Google Business Profile
  API is not connected. The service refuses it in production.

## Adding a brand

1. Add the brand to `KPI_BRANDS` in `server/src/kpi/config.js` with the KPIs that apply.
2. Make each connector in `connectors.js` return that brand's data in the normalized shape
   described at the top of that file (for example MaidCentral, or a CSV upload, for Clean Bee).
3. Nothing changes in the calc module or the page: the brand toggle appears once there are two.
