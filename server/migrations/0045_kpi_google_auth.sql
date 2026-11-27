-- KPI scorecard, live Google reviews (src/kpi/google.js). The Google Business Profile sign-in made
-- with "Connect Google" on the KPI page: one per brand. The refresh token is sealed with a key
-- derived from SESSION_SECRET, so the database alone can't use it. Reviews themselves go in
-- kpi_snapshots (source 'google'): ids, dates and star ratings only.
CREATE TABLE IF NOT EXISTS kpi_google_auth (
  brand text PRIMARY KEY,
  refresh_token text NOT NULL,
  google_email text,
  connected_by text,
  connected_at timestamptz NOT NULL DEFAULT now()
);
