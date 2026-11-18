# Kustomer historical migration

Moves UrbanMop's communication history out of Kustomer so it can appear in each customer's
**Story → Conversations**. Built in steps; only the first two are switched on:

1. **Export** (on): copy everything accessible in Kustomer into encrypted storage here.
2. **Dry run** (on): match each Kustomer customer to a Launch27 customer and report what an
   import would do. Nothing in the live inbox changes.
3. **Import** (built, **not enabled**): needs approval and a code change.

Admins: Support settings → **Kustomer migration**.

## What runs where

| | Development / QA | Production |
| --- | --- | --- |
| Kustomer read | A **synthetic** Kustomer made from the environment's test data | The real Kustomer, `KUSTOMER_API_KEY` (read-only roles) |
| Encryption key | Fixed test key (synthetic data only) | `KUSTOMER_EXPORT_KEY` (required) |

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
| Import (disabled) | `server/src/kustomer-migration/import.js` |
| Admin API / page | `server/src/kustomer-migration/api.js`, `web/src/inbox/KustomerMigrationPanel.tsx` |
| Tables | `server/migrations/0026_kustomer_migration.sql` |

**Storage.** Every Kustomer record is kept whole, compressed and encrypted, once per Kustomer id
(`kustomer_records`); a re-export updates it in place. Only ids, dates, channel and direction are
stored in the clear, for progress and the report. Nothing is committed to GitHub.

**Read-only.** The export only sends GET requests to Kustomer. The export and dry run can write
only to the `kustomer_*` tables (enforced in code), and the dry run reads the live inbox through a
SELECT-only handle. Tests compare every live table before and after.

### Matching (Launch27 is the authority)

1. The Kustomer customer's **email addresses**, primary first, against Launch27 customers' emails
   and the addresses agents have already linked to a support contact (that is how a second
   address matches).
2. Then **phone numbers agents already linked** to a contact (an established relationship).
3. A Launch27 customer's own phone number alone gives only **Review** (phones are shared).

| Result | Meaning | Import would… |
| --- | --- | --- |
| Confident | one Launch27 customer (method: email, secondary email, linked contact) | attach to that customer's Story |
| Review | phone number only | wait for a person |
| Ambiguous | an address or number is on several Launch27 customers | wait for a person |
| Conflict | the profile's addresses belong to different Launch27 customers | wait for a person |
| Unmatched | nobody known | keep the conversations with their Kustomer customer id, unlinked |
| Cleaner / Internal | a Launch27 cleaner / only our own addresses | not attach to a customer |

Never by name or message text. Several Kustomer profiles for one Launch27 customer are counted as
duplicate identities; they all attach to the same Story, and no customer is ever created.

### Duplicates

A Kustomer message is counted as already in the inbox when its email Message-ID matches one the
live Gmail channel stored, or an SMS has the same number, text and minute as a live text. A
conversation whose messages are all already there would be skipped. A conversation already
imported (same Kustomer id) is never imported twice.

## The import (not enabled)

`import.js` is complete and tested on a test database but nothing calls it, and it refuses to
run while `KUSTOMER_IMPORT_ENABLED` is `false`. When enabled (separately approved), for each
planned conversation it:

- creates one historical conversation: status *done*, original dates, **no queue, owner, reply
  target or SLA clock**, linked to the matched customer's support contact (an existing one, or one
  created once for that Launch27 customer);
- adds its messages with original timestamps and direction (`delivery_state = historical`),
  skipping ones already in the inbox, and internal notes as notes (never customer-visible);
- keeps Kustomer's status, tags, teams and owners in `conversations.source_meta`;
- never calls the live intake or reply code, so nothing is routed, assigned, notified, reopened
  or sent, and never changes an existing live conversation.

Safety: `conversations (source, source_id)` is unique and messages/notes use
`kustomer:msg:<id>` / `kustomer:note:<id>` external ids, so re-running is a no-op. Each row
carries `import_run_id`: `rollback(run)` deletes a run's conversations (messages cascade), and
`reconcile(dryRun, run)` compares what was imported with the plan. Batches run one transaction
each; a catch-up export plus a new dry run plan the conversations updated after the first import.

**Before enabling it:** approve the plan from a dry run; decide what to do with Review, Ambiguous,
Conflict and Unmatched; add an admin action that runs the import in batches with progress, using
the dry run's duplicate list; try it on one month of history and check a few Stories by hand.

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
