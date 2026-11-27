-- Add vincentbuenaventura.work@gmail.com as an agent ahead of their first sign-in, so admins
-- can put them on teams now (as migration 0036 did for three other agents). They start
-- offline and in Operations Queue, as a first sign-in would set them up. Signing in later
-- uses this same account, and they can change their name under their profile.
-- Only where someone has signed in already: on an empty database the first person to sign
-- in becomes admin, and this row would take that from them. A no-op if they already exist.
WITH added AS (
  INSERT INTO users (email, name, role, status_id, status_since)
  SELECT 'vincentbuenaventura.work@gmail.com', 'Vincent Buenaventura', 'agent', (SELECT id FROM agent_statuses WHERE kind = 'offline' ORDER BY position LIMIT 1), now()
  WHERE EXISTS (SELECT 1 FROM users)
  ON CONFLICT (email) DO NOTHING
  RETURNING id, email
), operations AS (
  INSERT INTO queue_members (queue_id, user_id)
  SELECT q.id, a.id FROM added a JOIN queues q ON q.slug = 'operations'
  ON CONFLICT DO NOTHING
)
INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'user.added', 'user', id::text, jsonb_build_object('email', email, 'role', 'agent', 'source', 'migration 0043') FROM added;
