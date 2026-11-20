-- Kustomer import runs (docs/kustomer-migration.md): one row per import of a dry run's plan,
-- with its progress (a cursor over the plan, so a stopped run resumes where it left off), counts,
-- the reconciliation against the plan, and who started or rolled it back.
CREATE TABLE IF NOT EXISTS kustomer_import_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dry_run_id bigint NOT NULL,                     -- not a foreign key: purging exports keeps the history of imports
  status text NOT NULL DEFAULT 'running',         -- running | stopped | completed | failed | rolled_back
  planned int NOT NULL DEFAULT 0,                 -- conversations the dry run marked 'new'
  processed int NOT NULL DEFAULT 0,
  batches int NOT NULL DEFAULT 0,
  conversations int NOT NULL DEFAULT 0,
  messages int NOT NULL DEFAULT 0,
  notes int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  cursor text,
  reconcile jsonb,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rolled_back_at timestamptz,
  rolled_back_by bigint REFERENCES users(id),
  rolled_back_conversations int,
  last_error text
);
CREATE INDEX IF NOT EXISTS conversations_import_run ON conversations (import_run_id) WHERE import_run_id IS NOT NULL;
