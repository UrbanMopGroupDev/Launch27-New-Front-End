-- An unsent reply kept on the conversation, so a conversation an agent started from
-- "New conversation" counts as work only once something is in it: a sent message, a note,
-- a call, or this draft. Cleared when the reply is sent.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS draft text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS draft_at timestamptz;
