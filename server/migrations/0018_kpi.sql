-- KPI scorecard (src/kpi/). Launch27, QuickBooks, Syft, Kustomer and Google stay the systems
-- of record and are only ever read; these tables hold what they cannot.

-- One row per source per refresh day: what was pulled, when, and whether it worked.
CREATE TABLE IF NOT EXISTS kpi_refresh_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand text NOT NULL,
  source text NOT NULL,               -- launch27 | kustomer | google | qbo | syft
  refresh_day date NOT NULL,
  status text NOT NULL,               -- ok | missing | failed
  row_count integer NOT NULL DEFAULT 0,
  note text,
  finished_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand, source, refresh_day)
);

-- Google reviews typed in by hand for a month while the Google Business Profile API is not
-- connected. Development and QA only; production has no way to write here.
CREATE TABLE IF NOT EXISTS kpi_manual_reviews (
  brand text NOT NULL,
  month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  new_reviews integer NOT NULL CHECK (new_reviews >= 0),
  avg_rating numeric(3,2) NOT NULL CHECK (avg_rating BETWEEN 1 AND 5),
  alltime_avg numeric(3,2) NOT NULL CHECK (alltime_avg BETWEEN 1 AND 5),
  alltime_count integer NOT NULL CHECK (alltime_count >= 0),
  entered_by text,
  entered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand, month)
);
