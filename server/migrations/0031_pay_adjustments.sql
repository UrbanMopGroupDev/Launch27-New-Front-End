-- Pay adjustments sheet, copied in on each reports build (src/reports/adjustments.js): late
-- cancellations, no-shows, late arrivals and Google review bonuses per cleaner. Replaced
-- whole on every sync. The sheet stays the record of truth, and this app never writes to it.
CREATE TABLE IF NOT EXISTS pay_adjustments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  row_no integer NOT NULL,
  cleaner_name text NOT NULL,
  kind text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  on_date date,
  customer text,
  details text,
  submitted_by text,
  valid boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS pay_adjustments_date ON pay_adjustments (on_date);

CREATE TABLE IF NOT EXISTS pay_adjustments_sync (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  synced_at timestamptz,
  row_count integer,
  error text
);
