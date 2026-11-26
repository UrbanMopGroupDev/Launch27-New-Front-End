-- Checking the complaint taxonomy by hand. A reviewer looks at a sample of cases and says
-- whether the engine's category was right; this keeps what the engine said at the time so
-- accuracy can be measured (complaint_cases.category is overwritten when a person fixes it).

CREATE TABLE IF NOT EXISTS complaint_reviews (
  case_id bigint PRIMARY KEY REFERENCES complaint_cases(id) ON DELETE CASCADE,
  reviewer_id bigint REFERENCES users(id),
  verdict text NOT NULL,          -- correct | wrong_category | not_complaint
  was_category text,              -- what the engine had
  was_classified_by text,         -- rules | claude
  now_category text,              -- what the reviewer chose (wrong_category only)
  note text,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

-- A case a reviewer marked "not a complaint" stays stored (so a later run doesn't re-add it)
-- but is left out of the playbook, the case list and the clients view.
ALTER TABLE complaint_cases ADD COLUMN IF NOT EXISTS excluded_at timestamptz;
