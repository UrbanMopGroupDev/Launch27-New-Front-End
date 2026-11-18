-- Live SMS through RingCentral (docs/sms.md).

-- Incoming SMS events, kept until processed. A webhook (or the Message Store check that
-- recovers missed ones) is stored here and acknowledged at once; the worker turns each into
-- an inbox message, retrying with backoff. The payload is cleared once processed: the text
-- then lives in messages like any other.
CREATE TABLE IF NOT EXISTS sms_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL DEFAULT 'ringcentral',
  message_key text NOT NULL,                       -- account/extension + RingCentral message id
  source text NOT NULL,                            -- webhook | reconcile
  status text NOT NULL DEFAULT 'pending',          -- pending | done | ignored | failed
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb,
  conversation_id bigint,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, message_key)                   -- the same text delivered twice is stored once
);
CREATE INDEX IF NOT EXISTS sms_events_due ON sms_events (next_attempt_at) WHERE status = 'pending';

-- One row per provider: connection, subscription and health, shown in Support settings → Channels.
CREATE TABLE IF NOT EXISTS sms_provider_state (
  provider text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,           -- an admin can disconnect (stop sending and receiving)
  health jsonb,                                    -- extension, numbers, missing permissions (no secrets)
  health_ok boolean NOT NULL DEFAULT false,
  last_health_at timestamptz,
  subscription_id text,
  subscription_expires_at timestamptz,
  last_webhook_at timestamptz,
  last_received_at timestamptz,
  reconcile_from timestamptz,
  last_reconcile_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A reply is saved before it is handed to the provider, under a key the composer sends once
-- per message, so a double click or a retried request can never send the same text twice.
CREATE UNIQUE INDEX IF NOT EXISTS msg_idempotency ON messages (conversation_id, (meta->>'idempotency_key')) WHERE meta ? 'idempotency_key';
-- Outbound texts still waiting for a final delivery status.
CREATE INDEX IF NOT EXISTS msg_sms_pending ON messages (created_at) WHERE channel = 'sms' AND direction = 'out' AND delivery_state IN ('queued', 'sent');
