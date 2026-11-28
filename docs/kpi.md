# KPI scorecard

**Reports → KPI scorecard** (`/reports/kpi`) is the monthly scorecard for UrbanMop (Ottawa
Residential). It is read-only: it never writes to Launch27, QuickBooks, Kustomer, Google or
Gmail, and it has no "edit data" controls.

**Status.** Development and QA run on synthetic data. Production reads Launch27 (churn,
fulfilment, visit counts), the Kustomer complaints the Complaint playbook already collects, and
the monthly Syft management report from Gmail (OCR), and Google reviews live from the Google
Business Profile API once an admin connects it (below). QuickBooks is not connected yet: OCR shows
the Syft report's stated figure with no cross-check. Until Google is connected, reviews come from
a dated export.

## Where the code is

| Part | Code |
| --- | --- |
| Brands, rule lists, thresholds | `server/src/kpi/config.js` |
| Every formula and exclusion rule | `server/src/kpi/calc.js` (pure; tests in `server/test/kpi.test.js`) |
| One read-only connector per source | `server/src/kpi/connectors.js` |
| Synthetic data for dev and QA | `server/src/kpi/synthetic.js` |
| Live connectors (production) | `server/src/kpi/live.js`, `server/src/kpi/syft.js`, `server/src/kpi/google.js`, `server/src/kpi/places.js` |
| Service and API (`/api/kpi/*`) | `server/src/kpi/service.js`, routes at the end of `server/src/inbox/api.js` |
| Page | `web/src/pages/KpiScorecard.tsx`, `web/src/kpi/api.ts` |
| Tables | `server/migrations/0029_kpi.sql` (`kpi_refresh_log`, `kpi_manual_reviews`), `server/migrations/0030_kpi_snapshots.sql` (`kpi_snapshots`), `server/migrations/0045_kpi_google_auth.sql` (`kpi_google_auth`) |

## Definitions

Every tile shows its value, status, change, **Target** and **Last 12 months** (the same two lines, in
the same words, on every tile), plus period, source, last refresh and an "i" button with the formula.
The page opens on **Summary**; **Detailed** (or a tile's "Details") adds the breakdowns, and "View rows"
goes down to the individual bookings and clients.
If a source is missing or has not refreshed in 48 hours, the tile says "No data" or "Stale"
and shows no number. A month with no data is a gap in the trend, never a zero.

| KPI | Formula | Sources |
| --- | --- | --- |
| Operational Cost Ratio | Operational delivery cost ÷ revenue. Included: cleaner wages (contractor + employee), payroll taxes / EI / CPP / workers' comp on cleaners, supplies, field vehicle costs, ops/office staff, ops software, recruitment ads. Excluded: office rent, general business insurance. Syft's figure is shown beside it, flagged when they differ by more than 1.0 percentage point. Provisional until the 10th of the following month. Status against the 63–68% target: On track at or under 68%, Warning within 5% above, Off track beyond | QuickBooks Online (source of truth), Syft report |
| Recurring client churn | Permanent churn events in the calendar month ÷ active recurring clients at the start of the month. Bands: ≤7% Excellent, 7–10% Healthy, 10–12% Elevated, over 12% High. Target under 6.8% | Launch27 |
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

## Periods

- **Month**: any month from January 2024, including the month in progress (shown "to date").
- **Trailing 12**: the 12 months ending at the chosen month, pooled.
- **Custom dates**: any start and end date up to today, compared with the same number of days
  before. Churn is events in the range ÷ clients with a recurring visit booked in the 31 days from
  the start date; the monthly bands and target are not applied to a partial period. OCR is
  reported by month only, so its tile reads "No data" for a custom range.

## Refresh schedule

Dev and QA: synthetic data is generated in memory, the same for everyone on a given day.

Production:

- **Launch27**: once a day after 5 am Toronto (and at start-up if it has never run), using the
  read-only sync login (`L27_SYNC_EMAIL` / `L27_SYNC_PASSWORD`). The first run and one run a week
  read the whole history from January 2024; the others read bookings from 120 days back to 60
  days ahead and merge them in. Only the login and GET requests are ever sent. The result is one
  slimmed snapshot in `kpi_snapshots`; review comments and contact details are not copied.
  "Refresh now" under Sources starts a run by hand, using the signed-in person's own
  Launch27 login. Without the sync login set, that button is the only way it refreshes.
- **Kustomer**: no extra calls. Complaints are read from `complaint_cases` (source `kustomer`,
  Residential, not merged, not marked "not a complaint"), which the Complaint playbook keeps up to
  date. Freshness is the playbook's last finished run; a month outside the periods it has read
  shows "No data" rather than zero complaints.
- **Syft report (OCR)**: once a day the mailbox in `KPI_SYFT_MAILBOX` is searched, read-only, for
  the bookkeeper's management-report emails. Each UrbanMop report PDF (file names have varied; the
  company on the cover is checked and the month is taken from the report itself) is read once
  and the Operational Cost Ratio and Total Income printed on its Financial Health Scorecard page
  are stored; the most recently received report that gives a month's figure wins (a revision, or the next
  month's report restating it in its previous-month column). The figure is for
  the whole company (Residential and Commercial), and it is Syft's own calculation, not the
  account-by-account definition above, until QuickBooks is connected.
- A failed refresh keeps the previous snapshot; the affected tiles turn "Stale" after 48 hours.
- Every refresh writes one row per source per day to `kpi_refresh_log` (updated in place).
- Only bookings at the Ottawa location count for UrbanMop Residential (`locations` in `KPI_BRANDS`).

- **Google reviews, live** (`server/src/kpi/google.js`): read once a day from the Google Business
  Profile API (and by Refresh now) into `kpi_snapshots` (source `google`): each review's id, date,
  stars, the reviewer's public name, the comment and our reply (for the drill-down). Read-only: the
  only calls after sign-in are GETs.
  - **Set up (once).** Google approves one Google Cloud project per business for the API. In that
    project: turn on the My Business Account Management API, My Business
    Business Information API and Google My Business API; create an OAuth client (Web application)
    with the redirect URI `https://<production host>/api/kpi/google/callback`; set
    `GBP_CLIENT_ID` and `GBP_CLIENT_SECRET` in Railway (production) and deploy. A client from any
    other project gets a quota of 0, and the page says so.
  - **Connect.** An admin who can see the scorecard opens Sources and data freshness › Google
    reviews › **Connect Google** and signs in with the account that manages the listing
    (info@urbanmop.ca). The refresh token is kept sealed in `kpi_google_auth` (migration 0045, key
    from `SESSION_SECRET`); `GBP_REFRESH_TOKEN` works instead. Disconnect forgets it.
  - **Which listing.** The one whose name or city matches the brand's `googleLocation` (Ottawa).
    If more than one could match, the refresh fails listing them: set `GBP_LOCATION`
    (`accounts/<id>/locations/<id>`).
  - **Until connected,** and until the first refresh, the tile reads Google Places public data
    (below) when its key is set, otherwise the dated Google Takeout export.
- **Google reviews from public data** (`server/src/kpi/places.js`, Places API (New)): needs no
  Business Profile approval, only `GOOGLE_PLACES_API_KEY` (any Google Cloud project with Places API
  (New) on and billing set; production only). The listing is found once by name (`googlePlaceQuery`)
  or set with `GOOGLE_PLACES_PLACE_ID`. Read once a day (and by Refresh now) into `kpi_snapshots`
  (source `google_places`): the listing's total and rating, and the up to 5 reviews Google shows
  (picked as "most relevant", not newest): id, date, stars, the reviewer's public name, the comment
  and its Google link. Every review Google has shown is kept, so the list grows over time.
  - **Counts are exact:** each day's rise in Google's total is that day's new reviews.
  - **Stars are partial:** known only for new reviews Google shows; the tile says "stars known for
    X of Y", and averages use the known stars.
  - History up to the export's last date comes from the export. Reviews between the export and the
    first read that Google never shows count all time, with no date.
  - Once the Business Profile API is read, it takes over (full history, every star).
  - **Dated export (last resort):** the tile reads the dated Google Takeout export
    in `server/src/kpi/data/google-reviews-urbanmop.json`, labelled "not live"; months after its
    last review read "No data".

Not built yet: the QuickBooks connector, the email alert when a refresh fails or
a source is stale, and per-brand roles for office managers.

## Google review drill-down

Click the Google reviews tile, or one of its details, to see the reviews for the period
(`server/src/kpi/review-details.js`, the reviews drill in `calc.js`):

- **All reviews,** newest first: date, stars, reviewer, comment, the Launch27 client the reviewer's
  name points to (same full name, or first name and last initial when only one client fits;
  "(likely)"), the cleaners the comment names, our reply (Business Profile API only) and a link to
  the review on Google (Places only).
- **Low stars (1–3★)**, **Not replied to** (Business Profile API only, oldest first),
  **Cleaners mentioned** and **Stars** (count per star; reviews Google showed without stars apart).
- **Cleaners** are matched by first name, whole words only. When two cleaners share it, the one who
  worked for the matched client is picked, otherwise the review says how many share the name.
- Client and cleaner are suggestions from names. Nothing is written anywhere: the Google review
  bonus is still recorded by a person (Cleaner reports).
- With Places data, reviewer and comment exist only for the reviews Google has shown; the
  Business Profile API fills in every review.

## Who sees it

Dev and QA: everyone who can sign in. Production: only the logins in `KPI_EMAILS`
(comma-separated; empty means nobody), because it carries financial figures.

## Dev and QA extras

- **Preview a source outage** (Sources card): shows how tiles behave when a source is stale
  or not connected.
- **Enter Google reviews by hand**: a manual monthly entry for testing the tile. The service
  refuses it in production.

## Adding a brand

1. Add the brand to `KPI_BRANDS` in `server/src/kpi/config.js` with the KPIs that apply.
2. Make each connector in `connectors.js` return that brand's data in the normalized shape
   described at the top of that file (for example MaidCentral, or a CSV upload, for Clean Bee).
3. Nothing changes in the calc module or the page: the brand toggle appears once there are two.
