# Complaint tracking and the Cleaner Adjustment form

The two tools the office used in Kustomer, rebuilt like for like so the team can leave Kustomer
(week 2 of December 2026). Copied as they were: no redesign, no new features.

Separate from the Complaint Resolution Engine (`docs/complaints-engine.md`, `/complaints`,
`complaint_cases`): the engine mines history and builds the playbook; this is where the office
works today's complaints. Neither reads or changes the other's tables.

## Complaint tracking (`/complaint-tracking`)

| Part | Where |
| --- | --- |
| Fields, picklists, saved views | `server/src/tracker/fields.js` |
| Records, views, comments, Kustomer load | `server/src/tracker/service.js` |
| Routes (`/api/tracker/*`) | `server/src/tracker/api.js` |
| Page (list, record) | `web/src/pages/ComplaintTracker.tsx` |
| Conversation buttons | `web/src/tracker/ConversationComplaint.tsx` |
| Tables | `server/migrations/0037_complaint_tracker.sql` |
| Tests | `server/test/tracker.test.js` |

Everyone signed in can see and work complaints, as in Kustomer.

**Where the definitions came from.** Read from the live Kustomer account on Nov 26, 2026
(read-only key): the Complaint object's fields, the values in use across all 1,178 complaints,
and the saved searches with their filters. Kustomer's field-definition API was not readable with
that key, so a picklist option nobody has ever used would be missing: add it in `fields.js`.

**Record.** Title, Open / Snoozed / Done, snooze, mark done, "Assign to me", assigned user, then
four panels (Complaint Information, Resolution Information, Approval, Complaint Category) and an
internal comments thread. Typing `@name` in a comment notifies that person (the bell opens the
complaint). Each field saves when you leave it. It links to its inbox conversation, its contact,
and the Launch27 customer and booking.

**Views** (Kustomer's searches under "Complaint Tracking", with live counts):

| View | Shows |
| --- | --- |
| For Review, Awaiting client response, Damaged Item, To Schedule a Reclean, Reclean scheduled, For Refund, Complaint Resolved / For Internal Investigation | Status is that value |
| Monetary Impact Assessment | Status Closed, Manager Impact Assessment empty |
| All Closed Complaints | Status Closed, Manager Impact Assessment filled |
| All Complaints Overview | Original Service Date filled |
| Input to UM Portal Required | "Input into UM Portal?" empty |
| No MIA Categories yet | MIA Categories empty |
| Input to UM Portal - Positive Feedback | Conversations marked "Positive feedback", until someone marks them entered |

The list has Kustomer's columns, sortable, with tick boxes for bulk actions (assign to me, mark
done, set status).

**From a conversation.** "Complaint" in the conversation toolbar opens the complaint already
made for that conversation, or makes one (customer, cleaner, booking and lifetime spend filled
in) and opens it. It replaces the old inline complaint panel; the conversation keeps its
complaint mark, which Cleaner reports count. "Positive feedback" lists the conversation under
Input to UM Portal - Positive Feedback.

**Launch27 ratings.** Launch27 stays the source of truth for ratings (they feed the cleaner app
and scores); this module is the source of truth for complaints. Nothing is written to Launch27.
"Input to UM Portal Required" shows the days left before the booking's rating link expires and
sorts by it. The window is `RATING_LINK_DAYS` (default 7): **confirm the real number in
Launch27's settings.** Phase 2 (not built): submitting the rating from here. The captured
Launch27 API (`docs/API.md`) has the ratings report only, no call that submits one, so whether
staff can submit a rating, and after the link expires, still has to be captured from Launch27's
admin screens.

**Loading from Kustomer** (production, admins: "Load from Kustomer" under the views). Reads
complaints created in the last 30 days plus every older one still being worked (a status that
isn't Closed), with their comments. GET only, through `complaints/sources/kustomer.js`. Safe to
run again, for example on cut-over day: a complaint already changed here is never overwritten,
and nothing is duplicated. Limits:

- Kustomer users can't be read with the key, so the Kustomer assignee isn't carried over, and
  loaded comments show as "Kustomer comment" without the author's name.
- A complaint links to its conversation only when Kustomer linked one (about a quarter do) and
  that conversation was imported; otherwise it links to the customer where the import knows them.
- Photos aren't copied ("Received Photos" is Yes/No).

Dev and QA have no Kustomer: they start with eight invented complaints.

## Cleaner Adjustment (pay adjustments)

A "Cleaner Adjustment" card beside a conversation and on customer and contact pages. Submit adds
one row to the pay adjustments Google Sheet; Open Sheet opens it. Customer name, address and
Submitted By are filled in from the conversation, the customer and who is signed in.

| Part | Where |
| --- | --- |
| Sheet layout, checks, writer (`/api/adjustments`) | `server/src/tracker/adjustments.js` |
| Card | `web/src/tracker/CleanerAdjustment.tsx` |
| Trail of what was sent | `pay_adjustment_submissions` |

| Form field | Sheet column |
| --- | --- |
| Cleaner Name | A Cleaner's Name |
| Adjustment Amount | B Adjustment Amount ($), as typed (deductions negative) |
| Category | C Description/Reason |
| Service Date | D Date and Time |
| Customer Name | E Customer Name |
| Net Impact | F Net Impact (Addition, Deduction, Exception) |
| Reason for Adjustment (1,024 characters) | G Additional Details, as `<category> -<date>T00:00:00.000Z - <reason>` |
| Submitted By | H Submitted By |
| Customer Address | K Address |
| Approved by | L Approved By |

Not written: I (Rule Set), J (Invoice Description) and O are the sheet's own formulas; M, N and P
are payroll's. The row goes in the first row with an empty column A (the blank rows below the data
already hold formulas, so Google's "append" would land thousands of rows down). Values are sent
raw, so typed text can never run as a formula.

- The sheet stays the record of truth. Its reader (`server/src/reports/adjustments.js`) is
  unchanged and reads these rows like any other.
- **The Google service account must be an Editor on the sheet** (it was a Viewer for the reader).
  If it isn't, Submit fails with a message saying so; nothing is worked around.
- Only production writes to the sheet (`PAY_ADJUSTMENTS_SHEET_ID`, `GMAIL_SERVICE_ACCOUNT_JSON`).
  In dev and QA a submission is recorded and marked as a test; Google is never called.
- No approval workflow: "Approved by" is a typed name, as in Kustomer.
