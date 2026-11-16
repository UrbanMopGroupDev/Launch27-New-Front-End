# Complaint Resolution Engine — Phase 1 plan (draft for Derek's sign-off)

Status: **proposal**. Nothing below has been built or migrated yet. Phase 2 (the
recommendation card, credit ledger, scoreboard) starts only after sign-off on Phase 1.

Scope: **Residential only** (`brand = 'residential'`). Read-only on every source system.

---

## 1. Where it lives

A new module in this app, following the existing patterns:

| Part | Where |
| --- | --- |
| Source connectors (Kustomer, Gmail, Slack, Launch27, later Ops inbox) | `server/src/complaints/sources/*.js`, one file each, same interface (`listSince(cursor)`, `toCase(raw)`) |
| Case builder, journey features, outcome classifier, cost model | `server/src/complaints/*.js` |
| Tables | New migration(s) in `server/migrations/` (Postgres, same DB as the inbox) |
| Pages | Support → **Complaints** (case list + playbook report); Settings → **Complaint rules** (ladder, approval limits, budget slider) |
| Backfill job | Runs **on Railway production** (where Launch27 and Kustomer data already are), not on a laptop or in a dev sandbox |

**Postgres, not SQLite.** The brief asks for a local SQLite case DB *and* for cases to live
in the Ops database ready for the Kustomer migration. Those pull in opposite directions;
the Ops Postgres does both jobs, keeps personal data inside Railway, and is what the
eventual Kustomer migration will land in anyway. Dev/QA keep using synthetic data.

---

## 2. Proposed schema

Design rules: every imported row keeps `source` + `source_id` (unique together) so the
later full Kustomer migration can't duplicate anything; nothing depends on Kustomer
existing long-term; raw Kustomer statuses are kept next to our own status.

```
complaint_cases                         one row per complaint
  id, brand ('residential')
  source            kustomer | ops_inbox | gmail | slack | launch27_rating | manual
  source_id         e.g. Kustomer kobject id          UNIQUE (source, source_id)
  conversation_id   -> conversations (Ops inbox thread, incl. migrated Kustomer threads)
  contact_id        -> contacts
  l27_customer_id, l27_booking_id, l27_team_ids[]
  opened_at, first_response_at, resolved_at
  channel           email | sms | voice | chat | review
  status            open | awaiting_client | reclean_scheduled | resolved | closed
  source_status     raw Kustomer value: For Review / Awaiting Response / Damaged Item / Reclean Scheduled
  category, subcategory, severity (1–4)
  tone              mild | frustrated | angry | threat_leave | threat_review
  areas_cited       jsonb  (kitchen, bathrooms, floors, baseboards…)
  hard_route        null | damage_over_100 | theft_missing | safety | misconduct | legal_chargeback
  handled_by, decided_by  -> users
  exchanges         number of back-and-forths
  classifier_confidence   0–1 (low = flagged for human review)

complaint_journeys                      snapshot of the client AS OF the complaint date
  case_id, tenure_days, frequency, cleans_total, lifetime_spend
  price_change_90d, distinct_cleaners_90d, cleaner_changed_last_visit
  prior_complaints, our_reschedules_90d, our_cancellations_90d, days_since_last_clean
  cleaner_id, cleaner_tenure_days, cleaner_is_trainee, cleaner_complaint_rate_90d

complaint_resolutions                   what was offered, in order (supports "L1, then L3")
  case_id, step, rung (L0–L7), action  apology | credit | reclean_spot | reclean_full | refund | damage_reimbursement
  pct, amount, offered_at, accepted (yes/no/unknown)
  decided_by, approved_by, approval_ref (Slack message link)

complaint_costs                         every dollar, by type
  case_id, kind     refund | credit | reclean_labour | reclean_travel | reclean_lost_slot | damage | cleaner_recovery (negative)
  amount, source, source_ref

complaint_outcomes                      checked at 30 / 60 / 90 days
  case_id, day, still_booking, next_booking_at, churned_at
  public_review_stars, public_review_platform, repeat_case_id
  outcome           saved | partial_save | lost | pending

conversations  (existing table)  + external_source, external_id   ← Kustomer threads land here
source_sync_state                connector, cursor, last_run_at, last_error
complaint_settings               ladder rungs, role limits, budget target %, credit expiry days
```

Phase 2 adds `customer_credits` (the credit ledger) and `complaint_recommendations`
(options shown, option chosen, by whom).

The existing **Complaint** panel on inbox conversations (`conversations.complaint`, with
outcome and "cost to us") becomes a thin view onto `complaint_cases`, so frontline only
has one place to log.

**Outcome rules** (as briefed): SAVED = still booking 60+ days later and no negative
public review; PARTIAL SAVE = left, no negative review; LOST = churned within 60 days
and/or 1–2★ public review. Repeat complaint within 90 days is flagged separately.

**Reclean cost** = cleaner pay for the reclean (Launch27 team payments) + travel (our
existing route model) + lost slot = the average residential booking margin that slot would
have earned that week (from Job profitability). Shown as one number with the breakdown.

---

## 3. Draft taxonomy (hypothesis — to be replaced by what the data says)

Seeded from the existing Customer feedback themes (`web/src/lib/feedbackModel.ts`) and a
first read of #finance-refunds. Final categories come out of the 6-month pilot.

| Category | Examples | Hard route? |
| --- | --- | --- |
| Quality — missed areas | Kitchen, baseboards, bathrooms not done | |
| Quality — rushed / short time | Left early, fewer hours than booked | |
| Quality — first clean | Deep/initial clean below expectations | |
| Punctuality / no-show | Late, didn't show, cancelled by us | |
| Cleaner change / consistency | "Not my usual cleaner" | |
| Scope / booking error | Wrong service, extras missed, wrong date | |
| Communication | No update, slow reply | |
| Pricing / billing | Overcharge, Affirm/payment mix-up, price increase | |
| Property condition | Cleaner couldn't continue the job | |
| Damage — under $100 | | |
| Damage — over $100 | Broken TV, sculpture | **Yes** |
| Missing item / theft | | **Yes** |
| Cleaner conduct / safety | | **Yes** |
| Legal threat / chargeback | | **Yes** |
| Review threat | "I'll post a review" — a *tone* flag, not a category | |

---

## 4. First signals from #finance-refunds (read-only sample, Nov 2024 – Aug 2026)

- **Volume is low**: ~25 refund messages over ~21 months. The 6-month pilot will hold
  fewer than 10 refunds. Refund-level conclusions need the full backfill.
- **Real refund rungs used**: 20%, 30%, 40%, 50% and full — not 15% / 25%.
- **Damage is split with the cleaner**: TV $250 and sculpture $197.75, 50% deducted from
  the cleaner's pay. The cost model needs a "cleaner recovery" line.
- **Non-complaint refunds are mixed in** (cancelled bookings, Affirm overpayment) and
  must be filtered out.
- **Refunds tied to Google reviews**: at least one full refund was given "for the removal
  of [a] negative review". Google's review policy prohibits offering incentives to change
  or remove reviews, so the engine should never suggest this.
- **Approval in practice ≠ approval on paper**: most refunds are posted by Jose as
  "FYI, processed", not requested and approved by Derek. We'll log both who decided
  and who approved.
- No new posts since Aug 25, 2026. Have refunds moved somewhere else?

---

## 5. Guardrails built in

- Every connector is read-only; no write calls to Kustomer, Gmail, Slack or Launch27.
- Mining runs on Railway production; personal data stays in our Postgres.
- If complaint text is classified with an LLM, names, emails, phones and addresses are
  stripped first (reusing `server/src/qa/anonymize.js`), and only the text needed is sent.
- The engine recommends; a person approves and sends.
- Every conclusion in the playbook states how many cases it rests on.
