-- Kustomer historical migration (docs/kustomer-migration.md).
--
-- Export: Kustomer's records are copied here as-is, encrypted (AES-256-GCM, key from
-- KUSTOMER_EXPORT_KEY), so nothing in the source is lost and nothing readable sits in the
-- database. Only ids, dates, channel/direction and counts are stored in the clear, for
-- progress, matching and the report.
CREATE TABLE IF NOT EXISTS kustomer_export_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL DEFAULT 'full',              -- full | catchup (conversations updated since a date)
  status text NOT NULL DEFAULT 'queued',          -- queued | running | paused | cancelled | completed | failed
  phase text NOT NULL DEFAULT 'customers',        -- customers | conversations | done
  source text NOT NULL,                           -- kustomer | synthetic
  scope jsonb NOT NULL DEFAULT '{}',              -- { since, attachments }
  next_link text,                                 -- checkpoint: next page of the customer list
  pages int NOT NULL DEFAULT 0,
  requests int NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);

-- One row per Kustomer customer per job: has its history been fetched?
CREATE TABLE IF NOT EXISTS kustomer_export_customers (
  job_id bigint NOT NULL REFERENCES kustomer_export_jobs(id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending',          -- pending | done | failed | skipped
  attempts int NOT NULL DEFAULT 0,
  error text,
  PRIMARY KEY (job_id, customer_id)
);
CREATE INDEX IF NOT EXISTS kustomer_export_customers_pending ON kustomer_export_customers (job_id, state);

-- Every exported record, once per Kustomer id (re-exports update it in place).
CREATE TABLE IF NOT EXISTS kustomer_records (
  kind text NOT NULL,                             -- customer | conversation | message | note | attachment
  kustomer_id text NOT NULL,
  customer_id text,                               -- the Kustomer customer it belongs to
  conversation_id text,                           -- for messages, notes, attachments
  source_created_at timestamptz,
  source_updated_at timestamptz,
  channel text,                                   -- message: email | sms | chat | …
  direction text,                                 -- message: in | out
  digest text NOT NULL,                           -- sha256 of the source record (changed?)
  data bytea NOT NULL,                            -- the full source record, compressed and encrypted
  job_id bigint,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, kustomer_id)
);
CREATE INDEX IF NOT EXISTS kustomer_records_customer ON kustomer_records (customer_id, kind);
CREATE INDEX IF NOT EXISTS kustomer_records_conversation ON kustomer_records (conversation_id, kind);

-- Dry runs: what an import would do. Ids, counts and decisions only.
CREATE TABLE IF NOT EXISTS kustomer_dry_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',         -- running | completed | failed
  results jsonb,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error text
);
CREATE TABLE IF NOT EXISTS kustomer_plan_customers (
  run_id bigint NOT NULL REFERENCES kustomer_dry_runs(id) ON DELETE CASCADE,
  kustomer_customer_id text NOT NULL,
  match text NOT NULL,                            -- confident | review | ambiguous | conflict | unmatched | cleaner | internal
  method text,                                    -- email | secondary_email | contact | phone
  l27_customer_id bigint,
  contact_id bigint,                              -- existing support contact it would use
  candidates bigint[] NOT NULL DEFAULT '{}',
  reason text,
  conversations int NOT NULL DEFAULT 0,
  messages int NOT NULL DEFAULT 0,
  notes int NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, kustomer_customer_id)
);
CREATE TABLE IF NOT EXISTS kustomer_plan_conversations (
  run_id bigint NOT NULL REFERENCES kustomer_dry_runs(id) ON DELETE CASCADE,
  kustomer_conversation_id text NOT NULL,
  kustomer_customer_id text,
  l27_customer_id bigint,
  action text NOT NULL,                           -- new | already_imported | skip
  match text,
  channels text[] NOT NULL DEFAULT '{}',
  messages int NOT NULL DEFAULT 0,
  notes int NOT NULL DEFAULT 0,
  duplicate_messages int NOT NULL DEFAULT 0,      -- already in the live inbox (Gmail / SMS since cut-over)
  preview_only_messages int NOT NULL DEFAULT 0,   -- Kustomer gave only a preview, not the full text
  first_at timestamptz,
  last_at timestamptz,
  reason text,
  PRIMARY KEY (run_id, kustomer_conversation_id)
);
CREATE INDEX IF NOT EXISTS kustomer_plan_conversations_customer ON kustomer_plan_conversations (run_id, l27_customer_id);

-- For the future import (not enabled): historical conversations keep their source and id, so a
-- repeated import can never create a second copy, and an import run can be rolled back.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_meta jsonb;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS import_run_id bigint;
CREATE UNIQUE INDEX IF NOT EXISTS conv_source_unique ON conversations (source, source_id) WHERE source IS NOT NULL;
