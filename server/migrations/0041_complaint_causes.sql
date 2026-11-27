-- Root causes: the second layer of the complaint taxonomy. The category says what the client
-- complained about; the cause says why it happened (codebook in server/src/complaints/taxonomy.js).
-- One root cause per case plus up to two contributing causes, with the client's words that show it.
ALTER TABLE complaint_cases ADD COLUMN IF NOT EXISTS cause text;
ALTER TABLE complaint_cases ADD COLUMN IF NOT EXISTS contributing_causes jsonb NOT NULL DEFAULT '[]';
ALTER TABLE complaint_cases ADD COLUMN IF NOT EXISTS cause_evidence text;
ALTER TABLE complaint_cases ADD COLUMN IF NOT EXISTS cause_by text;   -- rules | claude | human
CREATE INDEX IF NOT EXISTS complaint_cases_cause ON complaint_cases (cause);

-- Hand checks cover the cause as well as the category. Like was_category, was_cause keeps what
-- the engine said at the time, so the cause's accuracy can be measured after a person fixes it.
ALTER TABLE complaint_reviews ADD COLUMN IF NOT EXISTS was_cause text;
ALTER TABLE complaint_reviews ADD COLUMN IF NOT EXISTS was_cause_by text;
ALTER TABLE complaint_reviews ADD COLUMN IF NOT EXISTS now_cause text;
ALTER TABLE complaint_reviews ADD COLUMN IF NOT EXISTS cause_verdict text;   -- correct | wrong | null (not checked)
ALTER TABLE complaint_reviews ADD COLUMN IF NOT EXISTS now_contributing jsonb;

-- The client's regular cleaner (most visits in the 90 days before the complaint) and whether
-- they had stopped working with us: no visits with any client for 21+ days in the Launch27 data.
ALTER TABLE complaint_journeys ADD COLUMN IF NOT EXISTS regular_cleaner_name text;
ALTER TABLE complaint_journeys ADD COLUMN IF NOT EXISTS regular_cleaner_left boolean;
ALTER TABLE complaint_journeys ADD COLUMN IF NOT EXISTS regular_cleaner_last_worked date;
