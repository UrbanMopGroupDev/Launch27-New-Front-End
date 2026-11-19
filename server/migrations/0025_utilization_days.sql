-- Utilization: a daily record of each day's planner picture (docs: Reports → Utilization).
-- One row per calendar day: the cleaners with the hours they had set for that day, the day's
-- visits, closed dates and days marked unavailable. Saved for today and yesterday on every full
-- planner refresh, then left alone, so past weeks show hours as they were rather than being
-- rebuilt from cleaners' current hours. Read-only copy of Launch27 data; nothing writes back.
CREATE TABLE IF NOT EXISTS utilization_days (
  day date PRIMARY KEY,
  data jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
