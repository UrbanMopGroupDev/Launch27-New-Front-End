# Kustomer historical migration

Moves UrbanMop's communication history out of Kustomer so it can appear in each customer's
**Story → Conversations**. Built in three steps, all switched on:

1. **Export** (on): copy everything accessible in Kustomer into encrypted storage here.
2. **Dry run** (on): decide whose Story each Kustomer customer's history goes on (a Launch27
   customer, a cleaner, a contact already in the inbox, or a new profile) and report what an
   import would do. Nothing in the live inbox changes.
3. **Import** (on, approved): import the latest dry run's plan into the inbox as closed,
   historical conversations, in batches, with progress, stop/resume and rollback. Every
   conversation goes on someone's Story.

Everyone on the team (agents, supervisors and admins, signed in, whatever their queue access):
Support settings → **Kustomer migration**.

## What runs where

| | Development / QA | Production |
| --- | --- | --- |
| Kustomer read | A **synthetic** Kustomer made from the environment's test data | The real Kustomer, `KUSTOMER_API_KEY` (read-only roles) |
| Encryption key | Fixed test key (synthetic data only) | `KUSTOMER_EXPORT_KEY` (required) |
| Launch27 read for matching (dry run) | The environment's synthetic Launch27 | `L27_SYNC_EMAIL` / `L27_SYNC_PASSWORD` (read-only staff login; lists every customer and cleaner). Without it the dry run, and so the import, can't run |

## Setting it up (production)

1. **API key.** Reuse the complaint engine's read-only key (`KUSTOMER_API_KEY`) or create a
   dedicated one. It needs only *read* roles for **customers, conversations, messages, notes
   and attachments** (e.g. `org.user.customer.read`, `org.user.conversation.read`,
   `org.user.message.read`, `org.user.note.read`, `org.user.attachment.read`; names may differ
   in your Kustomer admin). **Test API connection** shows exactly which of these the key can
   read, and which is refused.
2. **Encryption key.** Set `KUSTOMER_EXPORT_KEY` in Railway production: 32+ random characters,
   kept only in Railway. Without it the export page stays off. Losing it makes the exported copy
   unreadable (export again); changing it does the same.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

3. Optional: `KUSTOMER_EXPORT_RPM` (default 300 requests a minute, 10–1000) to pace the export.

## Running it

1. **Test API connection** and **Preview export scope** (how many customers, if Kustomer says).
2. **Start full export.** It reads the customer list page by page, then each customer's
   conversations, each conversation's messages and internal notes, and attachment details
   (name, type, size, original link; the files themselves aren't copied). It runs in the
   background; **Pause**, **Resume** and **Cancel** work at any time, and a server restart pauses
   it rather than losing it. Expect about 1 request per customer plus 2 per conversation (at 300
   a minute, ~100,000 conversations take roughly 11 hours).
3. **Catch up** later with conversations updated since a date: customers active since then are
   re-read, and only conversations whose `updatedAt` changed are fetched again.
4. **Run the dry run**, read the summary and the match lists, open a customer to see each of its
   conversations and where it would go, and **Download report** (CSV).
5. **Delete exported data** when the migration is over.

## How it works

| Part | Code |
| --- | --- |
| Kustomer reads (GET only, retries 429/5xx, paced) | `server/src/complaints/sources/kustomer.js`, `server/src/kustomer-migration/source.js` |
| Field mapping (tolerant; full record always kept) | `server/src/kustomer-migration/normalize.js` |
| Encrypted storage (gzip + AES-256-GCM) | `server/src/kustomer-migration/vault.js` |
| Export job (resumable) | `server/src/kustomer-migration/export.js` |
| Matching and dry run | `server/src/kustomer-migration/dryrun.js` |
| Import (importer + batched job) | `server/src/kustomer-migration/import.js`, `server/migrations/0027_kustomer_import.sql`, `server/migrations/0035_kustomer_import_customers.sql` |
| API / page | `server/src/kustomer-migration/api.js`, `web/src/inbox/KustomerMigrationPanel.tsx` |
| Story (every conversation, paged) | `GET /api/contacts/:id/conversations` in `server/src/inbox/api.js`; `Story` in `web/src/inbox/Customer360.tsx`; the contact page (`web/src/pages/SupportPages.tsx`) |
| Tables | `server/migrations/0026_kustomer_migration.sql` |

**Storage.** Every Kustomer record is kept whole, compressed and encrypted, once per Kustomer id
(`kustomer_records`); a re-export updates it in place. Only ids, dates, channel and direction are
stored in the clear, for progress and the report. Nothing is committed to GitHub.

**Read-only.** The export only sends GET requests to Kustomer. The export and dry run can write
only to the `kustomer_*` tables (enforced in code), and the dry run reads the live inbox through a
SELECT-only handle. Tests compare every live table before and after.

### Matching (Launch27 is the authority): every profile gets a target

1. The Kustomer customer's **email addresses**, primary first, against Launch27 customers' emails
   and the addresses agents have already linked to a support contact (that is how a second
   address matches).
2. A Launch27 **cleaner** with one of those emails.
3. **Phone numbers agents already linked** to a customer, then a Launch27 customer's own phone
   number.
4. A **contact already in the inbox** that isn't in Launch27, with the same email (or, when
   Kustomer has no email for them, the same phone: a phone alone is often shared by a family).
5. Nobody: a **new profile** made from the Kustomer details. Internal accounts (only our own
   addresses) get one too.

When an address or number is on several Launch27 customers, one is **picked by rule**: the
primary address first; on a tie the customer agents already linked, otherwise the most recently
created Launch27 customer. The match list shows the rule's reason and the other candidates.

| Result | Meaning | Import puts the conversations on… |
| --- | --- | --- |
| Confident | one Launch27 customer (method: email, secondary email, linked contact) | that customer's Story |
| Phone | one Launch27 customer, by phone number only | that customer's Story |
| Picked | several Launch27 customers matched; one was picked by rule | the picked customer's Story |
| Cleaner | a Launch27 cleaner | the cleaner's profile (Messages) |
| Inbox contact | a contact already in the inbox, not in Launch27 | that contact's Story |
| Internal | only our own addresses | an internal profile (new, or the inbox contact with that address) |
| New profile | nobody known | a new customer profile from Kustomer's name, emails and phones |

Never by name or message text. Several Kustomer profiles for one Launch27 customer are counted as
duplicate identities; they all attach to the same Story. **No Launch27 customer is ever created:**
new profiles are support contacts in this app only (role *Customer*, listed under Contacts, with
"Link to Launch27" on their page), so Launch27's lists, KPIs and segments don't change. A dry run
made before this rule (no `plan_version` 2) can't be imported: run it again.

### Duplicates

A Kustomer message is counted as already in the inbox when its email Message-ID matches one the
live Gmail channel stored, or an SMS has the same number, text and minute as a live text. A
conversation whose messages are all already there would be skipped. A conversation already
imported (same Kustomer id) is never imported twice.

## The import

**Import N conversations** (step 4 on the page) imports the latest *completed* dry run's plan:
every conversation marked *new*, 50 per batch, one transaction per batch. Progress (processed,
batches, conversations, messages, notes, skipped) is saved after each batch in
`kustomer_import_runs`, so **Stop** halts it after the current batch and **Resume** carries on
from the next one; a server restart leaves a running import *stopped*. Only one import, export
or dry run runs at a time. When it finishes, the run is checked against the plan (imported vs
planned; missing; fewer messages or notes than planned) and the result shown. **Roll back**
deletes everything one run imported (its conversations, their messages and notes); contacts it
created for Launch27 customers stay (empty) so a re-import reuses them. Who started and who
rolled back each run is recorded. Rollback also deletes the **new profiles** the run made, when
they are left empty and still not linked to Launch27; a profile that has since received a live
message, or that an agent linked, is kept. `KUSTOMER_IMPORT_ENABLED = false` in `import.js`
switches the import off again.

For each planned conversation it:

- creates one historical conversation: status *done*, original dates, **no queue, owner, reply
  target or SLA clock**, always on a support contact: the Launch27 customer's or cleaner's (an
  existing one, or one created once for them), the inbox contact, or a new profile. Kustomer
  profiles that share an email end up on one profile, and a later import reuses the profiles an
  earlier one made (`kustomer_contacts`). A new profile never takes an email or phone another
  contact already has, so live messages from a shared number keep going where they went;
- adds its messages with original timestamps and direction (`delivery_state = historical`),
  skipping ones already in the inbox, and internal notes as notes (never customer-visible);
- keeps Kustomer's status, tags, teams and owners in `conversations.source_meta`;
- never calls the live intake or reply code, so nothing is routed, assigned, notified, reopened
  or sent, and never changes an existing live conversation or contact.

Once imported, a new profile behaves like any contact: live email or texts from its addresses
land on it (no "Who is this?" prompt), and an agent can link it to Launch27 from its page. Its
contact page shows a **Story** of every conversation, loaded a page at a time, and a customer's
Story and a cleaner's Messages page through all of theirs too (no 100-conversation cap).

Safety: `conversations (source, source_id)` is unique and messages/notes use
`kustomer:msg:<id>` / `kustomer:note:<id>` external ids, so re-running is a no-op. Each row
carries `import_run_id`: `rollback(run)` deletes a run's conversations (messages cascade), and
`reconcile(dryRun, run)` compares what was imported with the plan. Batches run one transaction
each; a catch-up export plus a new dry run plan the conversations updated after the first import.

The check after an import also counts conversations left **without a customer** (it should
always be 0). Duplicates are checked again at import time against the live inbox (email
Message-ID; SMS number, text and minute), not only from the dry run.

**Before importing for real:** run a fresh export (or catch-up) and dry run, read its report,
look through **Picked** and **Phone** rows (the rule chose for you) and **New profiles**, and
check a few Stories by hand after the import; roll back if anything is wrong.

## Limits and things to check on the real account

- Kustomer's documentation site couldn't be reached while this was built. The endpoints are the
  ones the complaint engine already uses on this account (`/v1/customers/{id}`,
  `/v1/customers/{id}/conversations`, `/v1/conversations/{id}/messages`) plus Kustomer's usual
  `/v1/customers` list, `/v1/conversations/{id}/notes` and `/v1/attachments/{id}`.
  **Test API connection** confirms each one before an export.
- Some messages may come with only a preview of the text; the dry run counts them ("Preview
  only"). If that number is large, the full bodies need another Kustomer endpoint.
- Attachment files aren't copied (no file storage yet); their details and original links are.
- If Kustomer limits how deep page-based listing goes, the customer list may stop early; the
  scope preview's total and the export's customer count show it.
