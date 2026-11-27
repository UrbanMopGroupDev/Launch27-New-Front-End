# Cleaner availability (days off and hours on a date)

Ported from the Commercial portal's release (Bookingkoala-Frontend PR 63). Launch27 only: nothing
here reads or writes BookingKoala, and the Luxoclean/Commercial portal is untouched.

## What the portal does

- **Availability calendar** on each cleaner's profile (Contacts › cleaner): a month read from
  Launch27 now, with the cleaner's visits each day. From it: a day off, hours for one date, time off
  over several days, back to the usual hours, and a history of the portal's changes.
- **Mark off** (cleaner plan and profile) saves the day off in Launch27 too, so Launch27, the planner
  and every tab agree. Undo puts that date back to the usual hours in Launch27. A day marked in the
  portal only, before this release, is cleared on undo.
- **Usual weekly hours** are still changed in Launch27 (Default Availability).

## How it is saved

The request Launch27's own "Specific date" screen sends: `POST /v1/staff/teams/:id/availability`
with a list of dated rows (`{ date, dayoff: true }` or `{ date, start_time, end_time, dayoff: false }`).
Each row replaces that date's one-off change; nothing else is touched. Launch27 has no delete, so
"back to usual hours" saves the date with the weekday's weekly hours. A weekday with split usual
hours (8–12 and 1–5) can't be sent as one row, so that is refused with a message to do it in Launch27.

- A change that would leave visits outside the cleaner's hours lists them first (409 `visits`) and
  is saved only when sent again with `confirm`. Mark off saves straight away and flags the visits in
  the planner's Changes.
- Every save is in the Launch27 write log (`l27_writes`) and the audit log; the portal's own history
  is `availability_changes` (migration 0042).
- Only when Launch27 writes are on (`L27_ALLOW_WRITES`). With writes off, nothing is sent and the
  attempt is logged as blocked.
- The `/l27` pass-through refuses availability writes: only these screens change availability.

## API (`/api/schedule`)

- `GET /cleaner/:id/availability?from&to` — weekly hours and each day (max 62 days).
- `POST /cleaner/:id/availability` — `{ changes: [...] }` or `{ from, to }` (time off), `confirm`, `note`.
- `GET /cleaner/:id/availability/history`
- `PUT /unavailable` — Mark off / undo (now saved in Launch27).

## Contacts › Cleaners

The team in one place (`/contacts?list=cleaners`), read from the planner's copy of Launch27:

- **Availability**: one row per cleaner, two weeks across (‹ › for more): usual hours (green), other
  hours that day (blue), **Day off** (orange), – not a working day, and the hours booked under the times.
  "Working on" keeps only the cleaners working that day; the last row counts who is working each day.
- **Team**: name, phone, status, area, today, hours booked of available and days off over the next 7 days.
- Search by name or phone; on hold and not ready cleaners are hidden unless ticked. Each name opens the
  cleaner's page, where days off are changed. API: `GET /api/schedule/team-availability?from&days` (max 28).
