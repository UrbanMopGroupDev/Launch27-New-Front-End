-- Each agent's email signature (Support settings -> My email signature): written with **bold**
-- and [link](address), added to the end of every email they send. No row: their name and the
-- business's name are used.
CREATE TABLE IF NOT EXISTS user_signatures (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
