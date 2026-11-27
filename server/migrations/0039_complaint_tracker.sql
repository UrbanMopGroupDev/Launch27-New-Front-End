-- Complaints tracker and Cleaner Adjustment form: the two Kustomer tools the office moves off
-- in December 2026 (docs/complaint-tracker.md). Like for like with Kustomer's Complaint object
-- and its saved searches. Separate from the Complaint Resolution Engine: complaint_cases and
-- its tables are not touched.

CREATE TABLE IF NOT EXISTS complaint_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL DEFAULT 'ops',     -- ops (made here) | kustomer (loaded) | sample (dev/QA)
  source_id text,                         -- Kustomer complaint id, so a reload never duplicates
  title text NOT NULL,
  state text NOT NULL DEFAULT 'open',     -- open | snoozed | done (Kustomer's Open badge / Mark done)
  snooze_until timestamptz,
  status text,                            -- Kustomer "Status" picklist
  complaint_created_on date,
  original_service_date date,
  cleaner_name text,
  type_of_service text,
  frequency text,
  complaint_notes text,
  cleaner_feedback text,
  received_photos text,                   -- Yes | No
  customer_name text,
  ltv_of_client numeric,
  due_date date,
  location text,
  case_opened_by text,
  cs_agent text,
  proposed_solution text,
  reclean_scheduling_required text,
  final_resolution_category text,
  final_resolution_details text,
  is_client_fully_satisfied text,
  input_into_um_portal text,              -- Yes | No | empty (still to do)
  case_closed_by text,
  closed_date date,
  manager_approval text,
  manager_impact_assessment text,
  at_risk_mia_amount numeric,
  mia_categories text,
  complaint_type text,
  complaint_type_2 text,
  complaint_category text,
  complaint_sub_category text,
  complaint_sub_category_2 text,
  complaint_sub_category_3 text,
  tier_level text,
  conversation_id bigint REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  l27_customer_id bigint,
  l27_booking_id bigint,
  assigned_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  source_meta jsonb NOT NULL DEFAULT '{}', -- Kustomer ids (customer, conversation, users) and fields as received
  edited_at timestamptz,                   -- set when someone changes it here; a reload then leaves it alone
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS complaint_records_source ON complaint_records (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS complaint_records_status ON complaint_records (status);
CREATE INDEX IF NOT EXISTS complaint_records_conversation ON complaint_records (conversation_id);
CREATE INDEX IF NOT EXISTS complaint_records_contact ON complaint_records (contact_id);

-- Internal comments on a complaint (never sent to the client). @mentions notify.
CREATE TABLE IF NOT EXISTS complaint_record_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_id bigint NOT NULL REFERENCES complaint_records(id) ON DELETE CASCADE,
  author_id bigint REFERENCES users(id) ON DELETE SET NULL,
  author_name text,                       -- for comments loaded from Kustomer
  body text NOT NULL,
  source_id text,                         -- Kustomer comment id
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaint_record_comments_record ON complaint_record_comments (record_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS complaint_record_comments_source ON complaint_record_comments (source_id) WHERE source_id IS NOT NULL;

-- A mention in a complaint comment opens the complaint, not a conversation.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS complaint_record_id bigint REFERENCES complaint_records(id) ON DELETE CASCADE;

-- "Input to UM Portal - Positive Feedback": conversations where a client praised a cleaner,
-- waiting for someone to enter it as a rating in Launch27.
CREATE TABLE IF NOT EXISTS um_portal_feedback (
  conversation_id bigint PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  flagged_by bigint REFERENCES users(id) ON DELETE SET NULL,
  flagged_at timestamptz NOT NULL DEFAULT now(),
  done_by bigint REFERENCES users(id) ON DELETE SET NULL,
  done_at timestamptz
);

-- Every Cleaner Adjustment the app sent to the pay adjustments sheet. The sheet stays the
-- record of truth; this is the trail of who sent what, and where it landed.
CREATE TABLE IF NOT EXISTS pay_adjustment_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submitted_by bigint REFERENCES users(id) ON DELETE SET NULL,
  conversation_id bigint REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  fields jsonb NOT NULL,
  outcome text NOT NULL,                  -- sent | sandbox | failed
  sheet_row integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
