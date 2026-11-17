# SMS (RingCentral)

Customers and cleaners text UrbanMop's business numbers; the texts arrive in the support inbox
like any other conversation, matched to the Launch27 customer or cleaner, routed by the routing
rules, with reply targets and assignment. Agents reply from the inbox. It runs on RingCentral
directly and does not depend on Kustomer.

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

**Disconnect** (admins, Support settings → Channels) removes the webhook subscription and stops
sending; texts that arrive meanwhile stay in RingCentral and are picked up on **Reconnect**.
To remove the integration entirely, delete the `RINGCENTRAL_SMS_*` variables.

## When something is wrong

- *Needs attention: the RingCentral app is missing permissions* → add them to the app in the
  developer console (they take effect at the next sign-in, within 30 minutes or on **Check connection**).
- *Can send: No* for a number → it lacks the SMS feature on that extension, or it isn't that
  extension's number.
- *sign-in failed … JWT token is expired / invalid* → create a new JWT credential and update
  `RINGCENTRAL_SMS_JWT` in Railway.
- A reply shows **not sent** with *may or may not have been sent* → RingCentral answered with an
  error after the request arrived; check the phone app before sending again.
- *Incoming queue: N failed* → those texts could not be processed after 8 tries; the reason is in
  the server log (`sms: could not process an incoming text`).
