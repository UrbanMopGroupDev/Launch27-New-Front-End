-- KPI scorecard, live data (src/kpi/live.js). The daily read-only pull from Launch27 is kept
-- as one slimmed snapshot per brand and source, so the scorecard never calls Launch27 while
-- someone is looking at it. Replaced in place on each refresh.
CREATE TABLE IF NOT EXISTS kpi_snapshots (
  brand text NOT NULL,
  source text NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  full_pull_at timestamptz,            -- last time the whole history was re-read, not just the recent window
  data jsonb NOT NULL,
  PRIMARY KEY (brand, source)
);
