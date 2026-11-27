-- Cleaner availability changed from the portal (docs/availability.md): each day off or one-off
-- hours saved in Launch27 from a cleaner's availability calendar or "Mark off", with what the
-- date was before, who did it and what Launch27 answered. Launch27 holds the availability; this
-- is the portal's history of its own changes.
CREATE TABLE IF NOT EXISTS availability_changes (
  id bigserial PRIMARY KEY,
  cleaner_id bigint NOT NULL,
  cleaner_name text,
  date date NOT NULL,
  before jsonb,                            -- the date's hours before: { hours, kind }
  after jsonb NOT NULL,                    -- what was sent: { dayoff } or { start_time, end_time }
  outcome text NOT NULL CHECK (outcome IN ('saved', 'failed')),
  error text,
  note text,
  source text,                             -- 'calendar' or 'mark_off'
  by_id bigint,
  by_name text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS availability_changes_cleaner ON availability_changes (cleaner_id, at DESC);
