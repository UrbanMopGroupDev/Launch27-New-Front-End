-- Solution mining (server/src/complaints/solutions.js): for each complaint case, what the client
-- asked for, what we offered in order and how they responded, what was finally agreed and how
-- the client sounded at the end, read by Claude from the client's own conversations (the
-- migrated Kustomer history and everything since). One row per case.
CREATE TABLE IF NOT EXISTS complaint_solutions (
  case_id bigint PRIMARY KEY REFERENCES complaint_cases(id) ON DELETE CASCADE,
  mined_at timestamptz NOT NULL DEFAULT now(),
  read_by text NOT NULL,                    -- claude | none (no conversation found to read)
  thread_messages int NOT NULL DEFAULT 0,   -- messages and notes read
  thread_last_at timestamptz,               -- newest one read: a thread that grows is read again
  conversation_ids jsonb NOT NULL DEFAULT '[]',
  asked_for text,                           -- an offer kind, or nothing_specific
  offers jsonb NOT NULL DEFAULT '[]',       -- [{kind, amount, pct, detail, client_response}]
  final_kind text,
  final_detail text,
  client_end text,                          -- satisfied | neutral | unhappy | unknown
  said_will_leave boolean,
  said_will_stay boolean,
  handling text                             -- one line, no names
);
CREATE INDEX IF NOT EXISTS complaint_solutions_final ON complaint_solutions (final_kind);
