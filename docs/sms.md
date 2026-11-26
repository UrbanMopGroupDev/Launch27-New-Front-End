# SMS (Twilio)

Customers and cleaners text UrbanMop's business numbers; the texts arrive in the support inbox
like any other conversation, matched to the Launch27 customer or cleaner, routed by the routing
rules, with reply targets and assignment. Agents reply from the inbox. SMS runs on **Twilio
only**, directly, and does not depend on Kustomer.

Every business number texts through Twilio (`TWILIO_SMS_NUMBERS`). Incoming texts go through one
queue, matching and routing (`server/src/inbox/sms/core.js`); replies go out from the
conversation's number (`createSmsRouter`).

**RingCentral SMS was removed.** Texts that arrived through RingCentral before the removal stay on
their conversations as history. Left-over `RINGCENTRAL_SMS_*` variables are ignored (the server
log names them so they can be deleted). **RingCentral calling is unchanged**: the phone widget,
click-to-call, call records and caller lookup (`RINGCENTRAL_CLIENT_ID`, `RINGCENTRAL_SERVER`) keep
working as before.

## How it works

| Part | Code | What happens |
| --- | --- | --- |
| Sign-in | `server/src/inbox/sms/twilio.js` | Basic auth with the Account SID and Auth Token, or an API key (`TWILIO_API_KEY_SID/SECRET`) for REST calls. The Auth Token is always needed to check webhook signatures |
| Health | `twilio-channel.js` `checkHealth` | At start-up and every 30 minutes: the account is **active**, which configured numbers have SMS capability, and which still send their incoming texts somewhere else (another app or Kustomer) |
| Outbound | `connector.send` | `POST Messages.json` from the conversation's number, with a status callback. Saved first as **sending**, then **queued / sent / delivered** or **not sent** with the reason. A 429 is retried; a 5xx is not (it may already have been sent). Twilio's own opt-out (error 21610) is explained to the agent |
| Delivery status | `POST /webhooks/twilio/status` + `updateDeliveries` | Signed status callbacks update the message (delivered never goes back); texts with no callback after 2 minutes are checked by polling |
| Inbound | `POST /webhooks/twilio/sms` | Every request must carry a valid `X-Twilio-Signature` for `TWILIO_WEBHOOK_BASE_URL` + path. Stored in `sms_events` by `MessageSid` (Twilio retries never duplicate) and answered with an empty TwiML `<Response>` (no automatic reply) |
| Missed texts | `reconcile` | Every 5 minutes, each number's incoming texts since the last check (10 minutes' overlap) are listed and queued if not already seen |

| Processing | `processEvents` (`core.js`) | Each stored text goes through `ingestInbound()` (matching, threading, STOP/START, routing, reply targets, assignment). Failures retry with backoff (2, 4, 8 … 60 minutes, 8 tries) |

Twilio runs **in production only**: it has no separate test data, so connecting dev or QA would
read real customers' texts. Dev and QA use the sandbox SMS channel and the Channel simulator.

### Who is it

Numbers are stored in E.164. A sender is matched to an existing contact by phone, otherwise looked
up in Launch27 (cleaners first, then customers; Launch27 stays the authority):

- **customer** → their customer Story; **cleaner** → their cleaner profile;
- **unknown** (no Launch27 customer or cleaner) → a **new contact** with just the number, routed
  like any other text; an agent can name them or link them to Launch27 from their contact page;
- **several Launch27 customers share the number** → a new contact linked to none of them (never
  guessed), and the conversation notes the customers' ids so an agent can link the right one.

A phone number or email belongs to one contact only, so the next text, call or email from it
finds the same contact (see "Contacts" in the README). Each business number
keeps its own conversation (a text to the hiring line never joins an Operations conversation),
and routing rules decide the queue (e.g. the hiring number → Hiring).

STOP / START (and the other carrier keywords) mark the number opted out or back in; texts to an
opted-out number are refused.

## Environments

| | Development / QA | Production |
| --- | --- | --- |
| Twilio | Ignored (`TWILIO_*` not read) | Connected when `TWILIO_*` is set |
| Sending | Never: recorded as "sandbox: not sent to customer" | Sent (`NOTIFICATIONS_MODE=live`) |
| Without credentials | Sandbox SMS channel + Channel simulator | "Not connected": replies saved, not sent |

## Setting it up (production)

1. In the Twilio console, note the **Account SID** and **Auth Token** (optionally create an
   **API key** for the REST calls). Check each number has **SMS** capability and that its
   A2P 10DLC / toll-free verification is approved, or carriers won't deliver.
2. In Railway (**production** only) set:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (and optionally `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`)
   - `TWILIO_SMS_NUMBERS`: every business number to text from, e.g.
     `+16136919880,+16136918368`. A number not listed here can't send or receive texts
   - `TWILIO_WEBHOOK_BASE_URL`: `https://<production domain>` (used for the webhook addresses and
     to check Twilio's signatures, so it must be exactly the address Twilio calls)
   - `NOTIFICATIONS_MODE=live` (the production default; `sandbox` records replies without sending)
   - `L27_SYNC_EMAIL` / `L27_SYNC_PASSWORD` (already used elsewhere) for Launch27 matching
3. Deploy. Support settings → Channels → **Text messages · Twilio** shows the incoming texts URL
   (`https://<production domain>/webhooks/twilio/sms`).
4. **Switching a number over** (it may be connected to Kustomer today): in the Twilio console,
   Phone Numbers → the number → Messaging → *A message comes in* → Webhook, `HTTP POST`, that URL.
   Until then the Channels screen flags the number ("incoming texts are still sent somewhere
   else"); replies from the inbox still work, but customers' texts won't arrive here. This app
   never changes a number's settings in Twilio itself.

Without `TWILIO_WEBHOOK_BASE_URL`, incoming texts arrive through the 5-minute check and
delivery status by polling.

**Disconnect** (admins, Support settings → Channels) stops sending and receiving texts; texts
that arrive meanwhile stay in Twilio and are picked up on **Reconnect**. To turn SMS off
entirely, delete the `TWILIO_*` variables.

## When something is wrong

- *No Twilio section on the Channels screen* → its variables were turned down
  when the server started. The screen lists the reason under **Text messages: set-up problems**
  (for example *TWILIO_SMS_NUMBERS is empty*, or
  `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` missing or misnamed: the screen names the `TWILIO_*`
  variables it found, never their values). Fix the variable on the production service and
  redeploy. `NOTIFICATIONS_MODE` doesn't decide whether Twilio appears, only whether replies
  are really sent.
- *Needs attention: the Twilio account is suspended* → resolve it in the Twilio console.
- Twilio replies **not sent** with *opted out with Twilio* → the person replied STOP to Twilio;
  only they can undo it (by replying START).
- Twilio webhooks refused (403 in the log) → `TWILIO_WEBHOOK_BASE_URL` doesn't match the address
  Twilio calls, or `TWILIO_AUTH_TOKEN` was rotated.
- *Incoming queue: N failed* → those texts could not be processed after 8 tries; the reason is in
  the server log (`sms: could not process an incoming text`).
- *Can send: No* for a number → it has no SMS capability on the Twilio account, or isn't one of
  the account's numbers.
- A number isn't on the Channels screen → add it to `TWILIO_SMS_NUMBERS` and redeploy.
