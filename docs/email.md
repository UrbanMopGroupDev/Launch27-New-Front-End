# Email channel (Gmail)

Customer email runs through the support inbox: mail sent to our addresses becomes a
conversation (routed, threaded, matched to the Launch27 customer, with a reply target), and
agents answer from the inbox or start an email from a customer's page. Every email
conversation is listed in the inbox and on the customer's page (Story → Conversations).

## Sending email

Email can be read **and sent**: agents reply by email in the customer's thread, start an email
from **New conversation** or a customer's page, and attach files. In production replies go
through Gmail; in development and QA every email is recorded as a sandbox message and nothing
is sent (as for texts).

- **Attachments**: the reply box's **Attach** button, dragging files onto it, or pasting a
  screenshot. Up to 10 files and about 18 MB together (Gmail's 25 MB limit after encoding).
  Kinds Gmail refuses (`.exe`, `.js`, `.bat`, …) are refused with a clear message. An email
  with files goes through Gmail's upload address. Files on sent emails are listed on the
  message and can be downloaded again from Gmail, like files on received mail.
- **Sending needs Google's permission**: reading and sending sign in separately
  (`gmail.readonly` and `gmail.send`). Until `gmail.send` is allowed in Google Workspace
  (setup step 3), replies show **not sent** with Google's reason, and reading keeps working.
- Turning sending off again is a code constant (`EMAIL_SENDING_ENABLED` in
  `server/src/inbox/channels.js`), not a setting: when false, email replies and new email
  conversations are refused and the connector the app gets cannot send.

Launch27 itself may still email customers about booking changes made through the app in
production (its own notifications); that is outside this setting.

## How it works

| Part | Code | What it does |
| --- | --- | --- |
| Sending (**off**) | `server/src/inbox/email/gmail.js` | `createGmailConnector`: sends a plain-text email through the Gmail API from the chosen address. Replies stay in the customer's thread: same Gmail thread, plus `In-Reply-To` / `References` headers so other mail apps thread it too |
| Receiving | `server/src/inbox/email/sync.js` | Every minute (`EMAIL_POLL_INTERVAL_MS`), reads new INBOX mail from each mailbox using Gmail's history id, and calls `ingestInbound()`: the same matching, threading, routing and SLA code the simulator uses |
| Reading mail | `server/src/inbox/email/mime.js` | Picks the text part (or converts HTML), cuts quoted history ("On … wrote:"), keeps Cc and attachment names |
| Health | Support settings → Channels, `GET /api/channels` | Connected / sandbox / not connected, and per mailbox: last check, last success, emails read, last error |

Threading: a new message joins an existing conversation when it is in the same Gmail thread
(`conversations.thread_key = gmail:<mailbox>:<threadId>`) or when its `In-Reply-To` /
`References` names a message already on a conversation (`messages.meta.message_id`). That
second rule catches replies that arrive in a different mailbox. Otherwise a new email is a
new conversation (a "done" one reopens if the reply comes within 14 days).

Who is it: the sender's address is matched to a contact (an address is on one contact only).
Someone new is looked up in Launch27 (cleaners first, then customers) with the `L27_SYNC_EMAIL`
login, so their conversation shows their bookings straight away; someone Launch27 doesn't know
becomes a new contact. A new address for a known Launch27 customer is added to their existing
contact. Opening a customer's page also copies any new email or phone from Launch27 onto their
contact, except one an agent removed from it or one that is on another contact.

Not changed in Gmail: nothing is deleted, labelled or marked as read, so the team can keep
using Gmail alongside the inbox during the switch. Mail from our own addresses, drafts, spam
and trash is skipped. Bounces and auto-replies are kept so an agent sees a reply didn't land.
Each email is stored once, by its Message-ID, even if it went to two of our addresses.

Attachments: names are shown on the message; the files stay in Gmail (we don't store files yet,
see docs/architecture.md).

## Environments

| | Development / QA | Production |
| --- | --- | --- |
| Email in the inbox | Works end to end with the **sandbox** channel: compose, thread, route | Gmail |
| Sending | Recorded as sandbox, never sent | Sent through Gmail (attachments included) |
| Reading mailboxes | Never (dev and QA must not hold real mail). Use the Channel simulator | Every minute |

`GMAIL_*` variables are ignored outside production (with a warning in the logs), so a copied
production variable can't make dev or QA read or send real mail.

## Setting it up (production)

Recommended: a Google Cloud **service account with domain-wide delegation**. One key reads
and sends for every mailbox, and no person's login is involved.

1. Google Cloud console → create a project (e.g. "UrbanMop Support") → enable the **Gmail API**.
2. IAM → Service accounts → create one (e.g. `support-inbox`) → Keys → Add key → JSON. Keep
   the file safe; it is a secret.
3. Google Workspace Admin → Security → Access and data control → API controls → Domain-wide
   delegation → Add new: the service account's **client ID** with these scopes:
   `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send`
   (if the client ID is already listed with only `gmail.readonly`, edit it and add `gmail.send`;
   without it, mail is still read but replies are not sent)
4. In Railway (production) set:
   - `GMAIL_SERVICE_ACCOUNT_JSON`: the whole JSON key (raw JSON, or base64 of it)
   - `GMAIL_MAILBOXES`: the mailboxes to read and send from, comma-separated, e.g.
     `info@urbanmop.ca,billing@urbanmop.ca,customersuccess@urbanmop.ca`. An address that is
     an alias or group delivered into another mailbox is written `alias=mailbox`
     (e.g. `management@urbanmop.ca=info@urbanmop.ca`); it must be set up as a "Send mail as"
     address on that mailbox in Gmail.
   - `L27_SYNC_EMAIL` / `L27_SYNC_PASSWORD` (already used by segments) so new senders are
     matched to their Launch27 customer
   - optional: `EMAIL_FROM_NAME` (default "UrbanMop"), `EMAIL_POLL_INTERVAL_MS` (default 60000)
5. Deploy, then open Support settings → Channels: each mailbox should show "OK" within a
   minute. The first check also reads the last day of inbox mail, so nothing sent during
   setup is missed.

Alternative for a single mailbox: an OAuth client plus a refresh token for that account
(`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, same scopes). Other
addresses can only be listed as its send-as aliases (`alias=mailbox`).

Agents can only pick "from" addresses that are in `GMAIL_MAILBOXES`.

## When something is wrong

- **Channels shows an error on a mailbox**: `Google sign-in failed: unauthorized_client`
  means the delegation (step 3) is missing or has different scopes. `Gmail 400: Precondition
  check failed` usually means the mailbox doesn't exist or isn't a Workspace user (use
  `alias=mailbox`).
- **A reply shows "failed" on the conversation**: the reason is under the message (for
  example an address not in `GMAIL_MAILBOXES`). Nothing was sent; fix and send again.
- **Server hasn't read mail for over a week**: Gmail's history expires; the sync notices and
  catches up from the last 7 days of inbox mail on its own.
