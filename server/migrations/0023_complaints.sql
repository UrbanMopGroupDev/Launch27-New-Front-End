-- Complaint Resolution Engine, Phase 1 (docs/complaints-engine.md).
-- One row per complaint case, with the client's journey before it, every resolution step,
-- every dollar it cost and the outcome at 30/60/90 days. Every imported row keeps its
-- source and source id so the later full Kustomer migration can't duplicate anything.
-- Residential only for now (brand column kept so Commercial can follow).

CREATE TABLE IF NOT EXISTS complaint_cases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand text NOT NULL DEFAULT 'residential',
  source text NOT NULL,                 -- kustomer | ops_inbox | gmail | slack | launch27_rating | manual
  source_id text NOT NULL,
  conversation_id bigint REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  customer_email text,                  -- normalized; how sources are linked to one client
  customer_phone text,                  -- E.164
  customer_name text,
  l27_customer_id bigint,
  l27_booking_id bigint,
  l27_team_ids jsonb NOT NULL DEFAULT '[]',
  service_date date,
  opened_at timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at timestamptz,
  channel text,                         -- email | sms | voice | chat | review | slack
  status text NOT NULL DEFAULT 'open',  -- open | awaiting_client | reclean_scheduled | resolved | closed
  source_status text,                   -- raw value from the source, e.g. Kustomer "Damaged Item"
  category text,
  subcategory text,
  severity smallint,                    -- 1 minor .. 4 severe
  tone text,                            -- mild | frustrated | angry | threat_leave | threat_review
  areas_cited jsonb NOT NULL DEFAULT '[]',
  hard_route text,                      -- damage_over_100 | theft_missing | safety | misconduct | legal_chargeback
  summary text,                         -- one line, no personal details
  handled_by text,                      -- staff name as written in the source
  decided_by text,
  exchanges int,
  classified_by text,                   -- rules | claude | human
  classifier_confidence real,
  merged_into bigint REFERENCES complaint_cases(id) ON DELETE SET NULL,  -- same complaint seen in two sources
  raw jsonb NOT NULL DEFAULT '{}',      -- source attributes as received (no message bodies)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS complaint_cases_opened ON complaint_cases (brand, opened_at DESC);
CREATE INDEX IF NOT EXISTS complaint_cases_customer ON complaint_cases (l27_customer_id, opened_at);
CREATE INDEX IF NOT EXISTS complaint_cases_email ON complaint_cases (customer_email);
CREATE INDEX IF NOT EXISTS complaint_cases_category ON complaint_cases (category);

-- The client as of the complaint date (computed from Launch27 history, never updated after).
CREATE TABLE IF NOT EXISTS complaint_journeys (
  case_id bigint PRIMARY KEY REFERENCES complaint_cases(id) ON DELETE CASCADE,
  tenure_days int,
  frequency text,
  cleans_total int,
  spend_12m numeric(10,2),
  price_change_pct real,                -- last visit price vs the average of the 3 before
  distinct_cleaners_90d int,
  cleaner_changed_last_visit boolean,
  prior_complaints int,
  prior_unhappy_ratings int,
  days_since_last_clean int,
  cleaner_id bigint,
  cleaner_name text,
  cleaner_visits_before int,            -- how experienced the cleaner was at that point
  cleaner_unhappy_rate_90d real,
  data_from date,                       -- how far back the history reached (12-month sync)
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- What was offered, in order ("L1, then L3 if they push back").
CREATE TABLE IF NOT EXISTS complaint_resolutions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES complaint_cases(id) ON DELETE CASCADE,
  step int NOT NULL DEFAULT 1,
  rung text,                            -- L0..L7
  action text NOT NULL,                 -- apology | credit | reclean_spot | reclean_full | refund | damage_reimbursement
  pct real,
  amount numeric(10,2),
  offered_at timestamptz,
  accepted text,                        -- yes | no | unknown
  decided_by text,
  approved_by text,
  approval_ref text,                    -- e.g. Slack message permalink / ts
  source text NOT NULL,
  source_id text NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS complaint_resolutions_case ON complaint_resolutions (case_id, step);

-- Every dollar, by type. cleaner_recovery is negative (the cleaner's share of a damage claim).
CREATE TABLE IF NOT EXISTS complaint_costs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES complaint_cases(id) ON DELETE CASCADE,
  kind text NOT NULL,                   -- refund | credit | reclean_labour | reclean_travel | reclean_lost_slot | damage | cleaner_recovery
  amount numeric(10,2) NOT NULL,
  source text NOT NULL,
  source_ref text NOT NULL,
  estimated boolean NOT NULL DEFAULT false,
  UNIQUE (case_id, kind, source, source_ref)
);

CREATE TABLE IF NOT EXISTS complaint_outcomes (
  case_id bigint NOT NULL REFERENCES complaint_cases(id) ON DELETE CASCADE,
  day int NOT NULL,                     -- 30 | 60 | 90
  checked_at timestamptz NOT NULL DEFAULT now(),
  still_booking boolean,
  next_booking_on date,
  last_booking_on date,
  public_review_stars smallint,
  public_review_platform text,
  repeat_case_id bigint REFERENCES complaint_cases(id) ON DELETE SET NULL,
  outcome text NOT NULL,                -- saved | partial_save | lost | pending
  PRIMARY KEY (case_id, day)
);

-- Raw items a connector pulled that may or may not be complaints (a Slack refund post, an
-- info@ email). Kept so a re-run doesn't re-fetch, and so a person can see what was skipped.
CREATE TABLE IF NOT EXISTS complaint_source_items (
  source text NOT NULL,
  source_id text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  occurred_at timestamptz,
  kind text,                            -- complaint | refund | review | not_complaint | unparsed
  case_id bigint REFERENCES complaint_cases(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}',     -- parsed fields only; message bodies are not stored here
  PRIMARY KEY (source, source_id)
);

CREATE TABLE IF NOT EXISTS complaint_sync_state (
  source text PRIMARY KEY,
  cursor text,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  stats jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS complaint_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  started_by bigint REFERENCES users(id) ON DELETE SET NULL,
  window_from date,
  window_to date,
  status text NOT NULL DEFAULT 'running', -- running | done | failed
  log jsonb NOT NULL DEFAULT '[]'
);

-- Ladder, approval limits, budget target, credit expiry. One JSON document, admin-edited.
CREATE TABLE IF NOT EXISTS complaint_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data jsonb NOT NULL DEFAULT '{}',
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Kustomer conversations land in the Ops inbox tables when migrated; keep their ids.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS external_source text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_external ON conversations (external_source, external_id) WHERE external_id IS NOT NULL;
