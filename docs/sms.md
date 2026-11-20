# SMS (RingCentral and Twilio)

Customers and cleaners text UrbanMop's business numbers; the texts arrive in the support inbox
like any other conversation, matched to the Launch27 customer or cleaner, routed by the routing
rules, with reply targets and assignment. Agents reply from the inbox. It runs on RingCentral
and/or Twilio directly and does not depend on Kustomer.

**Two providers.** Each business number belongs to exactly one provider (RingCentral or
Twilio). Incoming texts from both go through the same queue, matching and routing
(`server/src/inbox/sms/core.js`); a reply goes out through the provider that owns the
conversation's number (`createSmsRouter`). A number can't be configured for both.

## How it works

| Part | Code | What happens |
| --- | --- | --- |
| Sign-in | `server/src/inbox/sms/ringcentral.js` | Server-side JWT sign-in (`urn:ietf:params:oauth:grant-type:jwt-bearer`). The access token is kept in memory and renewed when it expires or RingCentral rejects it. Credentials come only from Railway variables |
| Health | `sms/service.js` `checkHealth` | At start-up and every 30 minutes: sign-in, the extension, its phone numbers and their `SmsSender` feature, and the app's permissions. Sending is refused until this passes |
| Outbound | `connector.send`, called by `sendOutbound()` | `POST /account/~/extension/~/sms` from the conversation's business number. The reply is saved first as **sending** under a one-time key (no double sends); it becomes **queued / sent / delivered** only once RingCentral accepts it, or **not sent** with the reason. A rate limit (429) is retried after `Retry-After`; a RingCentral error after the request may have arrived is **not** retried, to avoid texting twice |
| Delivery status | `updateDeliveries` | Every 2 minutes, texts still queued or sent in the last 24 hours are checked in the Message Store (delivered / failed) |
| Inbound | `POST /webhooks/ringcentral/sms` | RingCentral's instant SMS event. The address validation is answered; every event must carry our `Verification-Token` and our subscription id. Events are stored in `sms_events` and acknowledged at once |
| Processing | `processEvents` | Each stored event goes through `ingestInbound()` (matching, threading, STOP/START, routing, reply targets, assignment). Failures retry with backoff (2, 4, 8 … 60 minutes, 8 tries). A text is stored once, keyed by extension + RingCentral message id |
| Subscription | `ensureSubscription` | Every 10 minutes: creates the webhook subscription if missing, renews it when less than 2 days remain, recreates it if RingCentral suspended or removed it |
| Missed texts | `reconcile` | Every 5 minutes: inbound SMS in the Message Store since the last check (10 minutes' overlap) are queued if not already seen. This recovers anything missed during webhook downtime |

### Twilio

| Part | Code | What happens |
| --- | --- | --- |
| Sign-in | `server/src/inbox/sms/twilio.js` | Basic auth with the Account SID and Auth Token, or an API key (`TWILIO_API_KEY_SID/SECRET`) for REST calls. The Auth Token is always needed to check webhook signatures |
| Health | `twilio-channel.js` `checkHealth` | At start-up and every 30 minutes: the account is **active**, which configured numbers have SMS capability, and which still send their incoming texts somewhere else (another app or Kustomer) |
| Outbound | `connector.send` | `POST Messages.json` from the conversation's number, with a status callback. Saved first as **sending**, then **queued / sent / delivered** or **not sent** with the reason. A 429 is retried; a 5xx is not (it may already have been sent). Twilio's own opt-out (error 21610) is explained to the agent |
| Delivery status | `POST /webhooks/twilio/status` + `updateDeliveries` | Signed status callbacks update the message (delivered never goes back); texts with no callback after 2 minutes are checked by polling |
| Inbound | `POST /webhooks/twilio/sms` | Every request must carry a valid `X-Twilio-Signature` for `TWILIO_WEBHOOK_BASE_URL` + path. Stored in `sms_events` by `MessageSid` (Twilio retries never duplicate) and answered with an empty TwiML `<Response>` (no automatic reply) |
| Missed texts | `reconcile` | Every 5 minutes, each number's incoming texts since the last check (10 minutes' overlap) are listed and queued if not already seen |

Twilio runs **in production only**: it has no separate test data, so connecting dev or QA would
read real customers' texts. Dev and QA use the sandbox SMS channel and the Channel simulator.

### Who is it

Numbers are stored in E.164. A sender is matched to an existing contact by phone, otherwise looked
up in Launch27 (cleaners first, then customers; Launch27 stays the authority):

- **customer** → their customer Story; **cleaner** → their cleaner profile;
- **unknown** (no Launch27 customer or cleaner) → the **Who is this?** queue;
- **several Launch27 customers share the number** → **Who is this?**, with their ids listed; never guessed.

Linking the contact to Launch27 takes the conversation out of Who is this?. Each business number
keeps its own conversation (a text to the hiring line never joins an Operations conversation),
and routing rules decide the queue (e.g. the hiring number → Hiring).

STOP / START (and the other carrier keywords) mark the number opted out or back in; texts to an
opted-out number are refused.

## Environments

| | Development / QA | Production |
| --- | --- | --- |
| RingCentral platform | Sandbox only (`platform.devtest.ringcentral.com`), optional | Production (`platform.ringcentral.com`) |
| Twilio | Ignored (`TWILIO_*` not read) | Connected when `TWILIO_*` is set |
| Sending | Never: recorded as "sandbox: not sent to customer" | Sent (`NOTIFICATIONS_MODE=live`) |
| Without credentials | Sandbox SMS channel + Channel simulator | "Not connected": replies saved, not sent |

Production credentials are refused outside production, and the sandbox platform is refused in
production (`server/src/config.js`). The calling widget (`RINGCENTRAL_CLIENT_ID`) is separate
and unchanged.

## Setting it up (production)

1. **RingCentral developer console** → create an app: *REST API app*, server-side, auth
   **JWT auth flow**. Permissions: **SMS**, **Read Messages**, **Read Accounts**,
   **WebHook Subscriptions**. Get it approved for production.
2. Create a **JWT credential** for the user/extension whose numbers will text (the
   support extension). Its business numbers must have the **SMS** feature (*SmsSender*) —
   check in the RingCentral admin portal; toll-free and local numbers need the account's
   **TCR/10DLC registration** completed before carriers deliver texts.
3. In Railway (**production** environment only) set:
   - `RINGCENTRAL_SMS_CLIENT_ID`, `RINGCENTRAL_SMS_CLIENT_SECRET`, `RINGCENTRAL_SMS_JWT`
   - `RINGCENTRAL_SMS_NUMBERS`: the business numbers allowed to text, e.g.
     `+16136919880,+16136918368` (defaults to the numbers in the inbox's seed list)
   - `RINGCENTRAL_SMS_WEBHOOK_URL`: `https://<production domain>/webhooks/ringcentral/sms`
   - `RINGCENTRAL_SMS_WEBHOOK_TOKEN`: 16-64 random characters
     (`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`)
   - `NOTIFICATIONS_MODE=live` (otherwise replies are recorded, not sent)
   - `L27_SYNC_EMAIL` / `L27_SYNC_PASSWORD` (already used elsewhere) for Launch27 matching
4. Deploy, then Support settings → Channels → **Text messages**: every number should say
   *Can send: Yes*, with the queue its texts go to, and the webhook subscription *active*.
   Send a test text to each number and reply to it.

Without `RINGCENTRAL_SMS_WEBHOOK_URL`, texts still arrive through the 5-minute Message Store
check, just not instantly.

## Setting up Twilio (production)

1. In the Twilio console, note the **Account SID** and **Auth Token** (optionally create an
   **API key** for the REST calls). Check each number has **SMS** capability and that its
   A2P 10DLC / toll-free verification is approved, or carriers won't deliver.
2. In Railway (**production** only) set:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (and optionally `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`)
   - `TWILIO_SMS_NUMBERS`: the Twilio numbers to text from, e.g. `+16136918368`. None of them may
     also be in `RINGCENTRAL_SMS_NUMBERS`
   - `TWILIO_WEBHOOK_BASE_URL`: `https://<production domain>` (used for the webhook addresses and
     to check Twilio's signatures, so it must be exactly the address Twilio calls)
   - `NOTIFICATIONS_MODE=live`
3. Deploy. Support settings → Channels → **Text messages · Twilio** shows the incoming texts URL
   (`https://<production domain>/webhooks/twilio/sms`).
4. **Switching a number over** (it may be connected to Kustomer today): in the Twilio console,
   Phone Numbers → the number → Messaging → *A message comes in* → Webhook, `HTTP POST`, that URL.
   Until then the Channels screen flags the number ("incoming texts are still sent somewhere
   else"); replies from the inbox still work, but customers' texts won't arrive here. This app
   never changes a number's settings in Twilio itself.

Without `TWILIO_WEBHOOK_BASE_URL`, incoming texts arrive through the 5-minute check and
delivery status by polling.

**Disconnect** (admins, Support settings → Channels, per provider) stops sending and receiving
on that provider (for RingCentral it also removes the webhook subscription); texts that arrive
meanwhile stay with the provider and are picked up on **Reconnect**. To remove a provider
entirely, delete its `RINGCENTRAL_SMS_*` or `TWILIO_*` variables.

## When something is wrong

- *No Twilio (or RingCentral) section on the Channels screen* → its variables were turned down
  when the server started. The screen lists the reason under **Text messages: set-up problems**
  (for example *TWILIO_SMS_NUMBERS is empty*, a number also listed for RingCentral, or
  `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` missing or misnamed: the screen names the `TWILIO_*`
  variables it found, never their values). Fix the variable on the production service and
  redeploy. `NOTIFICATIONS_MODE` doesn't decide whether a provider appears, only whether replies
  are really sent.
- *Needs attention: the RingCentral app is missing permissions* → add them to the app in the
  developer console (they take effect at the next sign-in, within 30 minutes or on **Check connection**).
- *Can send: No* for a number → it lacks the SMS feature on that extension, or it isn't that
  extension's number.
- *sign-in failed … JWT token is expired / invalid* → create a new JWT credential and update
  `RINGCENTRAL_SMS_JWT` in Railway.
- A reply shows **not sent** with *may or may not have been sent* → RingCentral answered with an
  error after the request arrived; check the phone app before sending again.
- Twilio *Needs attention: the Twilio account is suspended* → resolve it in the Twilio console.
- Twilio replies **not sent** with *opted out with Twilio* → the person replied STOP to Twilio;
  only they can undo it (by replying START).
- Twilio webhooks refused (403 in the log) → `TWILIO_WEBHOOK_BASE_URL` doesn't match the address
  Twilio calls, or `TWILIO_AUTH_TOKEN` was rotated.
- *Incoming queue: N failed* → those texts could not be processed after 8 tries; the reason is in
  the server log (`sms: could not process an incoming text`).
