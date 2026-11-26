-- Kustomer import: every conversation goes to someone (docs/kustomer-migration.md).
--
-- The dry run now gives each Kustomer profile a target: a Launch27 customer's Story, a
-- cleaner's profile, a contact already in the inbox, or a new customer profile made from the
-- Kustomer details (internal accounts included).
ALTER TABLE kustomer_plan_customers ADD COLUMN IF NOT EXISTS target text;          -- customer | cleaner | contact | new
ALTER TABLE kustomer_plan_customers ADD COLUMN IF NOT EXISTS l27_team_id bigint;   -- target cleaner

-- Contacts the import created, so a later import reuses them and a rollback removes the new
-- profiles it made (contacts for Launch27 customers and cleaners are kept, as before).
CREATE TABLE IF NOT EXISTS kustomer_contacts (
  contact_id bigint PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  kustomer_customer_id text NOT NULL,
  kind text NOT NULL,                             -- profile | internal | customer | cleaner
  import_run_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kustomer_contacts_customer ON kustomer_contacts (kustomer_customer_id);
CREATE INDEX IF NOT EXISTS kustomer_contacts_run ON kustomer_contacts (import_run_id);

ALTER TABLE kustomer_import_runs ADD COLUMN IF NOT EXISTS profiles int NOT NULL DEFAULT 0;        -- new profiles created
ALTER TABLE kustomer_import_runs ADD COLUMN IF NOT EXISTS rolled_back_profiles int;
