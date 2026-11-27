-- Complaint tracking: the names on a complaint linked to real records, so reports can count
-- by cleaner and by person (docs/complaint-tracker.md). The typed or Kustomer name stays
-- beside each id. No foreign keys to users: adding one would lock the users table that every
-- request reads; the ids are joined on read.

-- Give up rather than wait behind the running app (a waiting deploy looks hung).
SET LOCAL lock_timeout = '15s';

ALTER TABLE complaint_records ADD COLUMN IF NOT EXISTS cleaner_id bigint;               -- Launch27 cleaner (team) id
ALTER TABLE complaint_records ADD COLUMN IF NOT EXISTS case_opened_by_user_id bigint;
ALTER TABLE complaint_records ADD COLUMN IF NOT EXISTS cs_agent_user_id bigint;
ALTER TABLE complaint_records ADD COLUMN IF NOT EXISTS case_closed_by_user_id bigint;
ALTER TABLE complaint_records ADD COLUMN IF NOT EXISTS manager_approval_user_id bigint;
CREATE INDEX IF NOT EXISTS complaint_records_cleaner ON complaint_records (cleaner_id) WHERE cleaner_id IS NOT NULL;

-- Complaints made here so far: who opened them is the login that made them.
UPDATE complaint_records SET case_opened_by_user_id = created_by WHERE case_opened_by_user_id IS NULL AND created_by IS NOT NULL;

-- The cleaner already set on the complaint's conversation, when the names agree.
UPDATE complaint_records r SET cleaner_id = c.cleaner_id
  FROM conversations c
 WHERE c.id = r.conversation_id AND r.cleaner_id IS NULL AND c.cleaner_id IS NOT NULL
   AND lower(btrim(c.cleaner_name)) = lower(btrim(r.cleaner_name));

-- Staff names that match exactly one login (by name or email). Others stay as typed.
UPDATE complaint_records r SET case_opened_by_user_id = (SELECT u.id FROM users u WHERE lower(btrim(u.name)) = lower(btrim(r.case_opened_by)) OR lower(u.email) = lower(btrim(r.case_opened_by)))
 WHERE r.case_opened_by_user_id IS NULL AND r.case_opened_by IS NOT NULL
   AND (SELECT count(*) FROM users u WHERE lower(btrim(u.name)) = lower(btrim(r.case_opened_by)) OR lower(u.email) = lower(btrim(r.case_opened_by))) = 1;
UPDATE complaint_records r SET cs_agent_user_id = (SELECT u.id FROM users u WHERE lower(btrim(u.name)) = lower(btrim(r.cs_agent)) OR lower(u.email) = lower(btrim(r.cs_agent)))
 WHERE r.cs_agent_user_id IS NULL AND r.cs_agent IS NOT NULL
   AND (SELECT count(*) FROM users u WHERE lower(btrim(u.name)) = lower(btrim(r.cs_agent)) OR lower(u.email) = lower(btrim(r.cs_agent))) = 1;
UPDATE complaint_records r SET case_closed_by_user_id = (SELECT u.id FROM users u WHERE lower(btrim(u.name)) = lower(btrim(r.case_closed_by)) OR lower(u.email) = lower(btrim(r.case_closed_by)))
 WHERE r.case_closed_by_user_id IS NULL AND r.case_closed_by IS NOT NULL
   AND (SELECT count(*) FROM users u WHERE lower(btrim(u.name)) = lower(btrim(r.case_closed_by)) OR lower(u.email) = lower(btrim(r.case_closed_by))) = 1;
UPDATE complaint_records r SET manager_approval_user_id = (SELECT u.id FROM users u WHERE lower(btrim(u.name)) = lower(btrim(r.manager_approval)) OR lower(u.email) = lower(btrim(r.manager_approval)))
 WHERE r.manager_approval_user_id IS NULL AND r.manager_approval IS NOT NULL
   AND (SELECT count(*) FROM users u WHERE lower(btrim(u.name)) = lower(btrim(r.manager_approval)) OR lower(u.email) = lower(btrim(r.manager_approval))) = 1;
