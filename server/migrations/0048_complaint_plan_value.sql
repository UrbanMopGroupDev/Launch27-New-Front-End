-- What a client's plan is worth in a year, as of the complaint: their usual visit price times
-- the visits a year their frequency means (journey.js, planValue). For a one-time client it is
-- the price of one visit. This, not past spend, is what is at stake when a client complains:
-- most complaints come on a first or second clean, when past spend says almost nothing.
ALTER TABLE complaint_journeys ADD COLUMN IF NOT EXISTS plan_value numeric(10,2);
ALTER TABLE complaint_journeys ADD COLUMN IF NOT EXISTS visit_price numeric(10,2);
