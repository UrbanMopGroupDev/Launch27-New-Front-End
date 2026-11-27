-- One contact per person: an email address or phone number belongs to one contact only, and a
-- Launch27 customer or cleaner has one contact only. Existing duplicates are merged here, and
-- unique indexes keep it that way. "Who is this?" (conversations.needs_match) is retired:
-- unknown senders simply become new contacts. The needs_match column stays (always false now).
--
-- This replaces 0037_one_contact_per_identity, which ran only on development and was removed
-- before reaching QA or production. Everything here is safe to run after it.
--
-- During the deploy the previous release may still run for a moment: an inbound text or email
-- it handles can then fail on the new unique indexes; both channels retry, and the new release
-- takes it.
--
-- What is merged (each merge is audited as contact.merged, with the merged contact's details):
--   1. contacts linked to the same Launch27 customer, then to the same Launch27 cleaner. One
--      linked to a different cleaner (or customer) than the contact kept is another person: it
--      keeps its own link and only loses the duplicate one (audited as contact.unlinked);
--   2. a contact with no Launch27 link that shares an email or phone with another contact joins
--      the best contact behind its emails and phones (through others like it, in a chain). An
--      email or phone shared by two or more Launch27 customers or cleaners (a household phone, a
--      placeholder email) proves nothing, so it isn't used to merge. Contacts linked to Launch27
--      are never merged with each other here.
-- The contact kept is the one linked to a cleaner, else to a customer, else with a name, else
-- the oldest. It keeps its details and takes the others' where it has none (notes are joined; a
-- spam or wrong-number mark never lands on a Launch27 contact). Conversations, complaint cases
-- and emails and phones move to it. A number that replied STOP on any copy stays opted out.
-- Finally an email or phone still on several contacts (only Launch27 people now) stays on the
-- contact that would have been kept and comes off the others (audited as identity.deduplicated).

CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone text PRIMARY KEY,                         -- E.164; a STOP kept while no contact has the number
  opted_out_at timestamptz NOT NULL DEFAULT now()
);

-- Emails and phones an agent took off a contact: the refresh from Launch27 doesn't put them back,
-- and a message from one isn't filed under that contact again.
CREATE TABLE IF NOT EXISTS contact_identity_removals (
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  value text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, kind, value)
);

-- Who opted a number out: 'stop' (they texted STOP; only their START turns texts back on) or
-- 'agent' (ticked by hand). Opt-outs from before this are taken as STOP, to be safe.
ALTER TABLE contact_identities ADD COLUMN IF NOT EXISTS opted_out_by text;
UPDATE contact_identities SET opted_out_by = 'stop' WHERE opted_out AND opted_out_by IS NULL;
ALTER TABLE sms_opt_outs ADD COLUMN IF NOT EXISTS opted_out_by text NOT NULL DEFAULT 'stop';

-- Conversations left without a contact when a Launch27 customer's or cleaner's contact was
-- deleted: they go back to the person's next contact (opening them again makes one).
CREATE TABLE IF NOT EXISTS contact_detached (
  conversation_id bigint PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  l27_customer_id bigint,
  l27_team_id bigint,
  detached_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_detached_customer ON contact_detached (l27_customer_id) WHERE l27_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_detached_team ON contact_detached (l27_team_id) WHERE l27_team_id IS NOT NULL;

-- A STOP on any copy of a number counts for every copy.
UPDATE contact_identities i SET opted_out = true, opted_out_at = COALESCE(i.opted_out_at, o.at, now()), opted_out_by = 'stop'
FROM (SELECT kind, value, max(opted_out_at) AS at FROM contact_identities WHERE opted_out GROUP BY kind, value) o
WHERE i.kind = o.kind AND i.value = o.value AND (NOT i.opted_out OR i.opted_out_by IS DISTINCT FROM 'stop');

CREATE TEMP TABLE merge_map (drop_id bigint PRIMARY KEY, keep bigint NOT NULL) ON COMMIT DROP;

-- ---------- 1a. the same Launch27 customer ----------

CREATE TEMP TABLE keep_l27 ON COMMIT DROP AS
SELECT DISTINCT ON (l27_customer_id) l27_customer_id AS l27_id, id AS keep, l27_team_id AS other
FROM contacts WHERE l27_customer_id IS NOT NULL
ORDER BY l27_customer_id, (l27_team_id IS NOT NULL) DESC, (NULLIF(btrim(name), '') IS NOT NULL) DESC, id;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.unlinked', 'contact', c.id::text, jsonb_build_object('by', 'migration 0038: a different cleaner than the contact kept for this customer', 'l27_customer_id', c.l27_customer_id, 'kept_on', k.keep)
FROM contacts c JOIN keep_l27 k ON k.l27_id = c.l27_customer_id
WHERE c.id <> k.keep AND c.l27_team_id IS NOT NULL AND k.other IS NOT NULL AND c.l27_team_id <> k.other;

UPDATE contacts c SET l27_customer_id = NULL, updated_at = now()
FROM keep_l27 k
WHERE k.l27_id = c.l27_customer_id AND c.id <> k.keep AND c.l27_team_id IS NOT NULL AND k.other IS NOT NULL AND c.l27_team_id <> k.other;

INSERT INTO merge_map
SELECT c.id, k.keep FROM contacts c JOIN keep_l27 k ON k.l27_id = c.l27_customer_id WHERE c.id <> k.keep;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.merged', 'contact', m.keep::text,
       jsonb_build_object('by', 'migration 0038: one contact per Launch27 customer',
                          'merged', jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'roles', c.roles, 'l27_customer_id', c.l27_customer_id, 'l27_team_id', c.l27_team_id, 'lead_stage', c.lead_stage, 'lead_source', c.lead_source, 'caller_flag', c.caller_flag, 'notes', c.notes) ORDER BY c.id))
FROM merge_map m JOIN contacts c ON c.id = m.drop_id
GROUP BY m.keep;

UPDATE contacts k SET
  name = COALESCE(NULLIF(btrim(k.name), ''), x.name),
  l27_customer_id = COALESCE(k.l27_customer_id, x.l27_customer_id),
  l27_team_id = COALESCE(k.l27_team_id, x.l27_team_id),
  lead_stage = COALESCE(k.lead_stage, x.lead_stage),
  lead_source = COALESCE(k.lead_source, x.lead_source),
  communication_preference = COALESCE(k.communication_preference, x.communication_preference),
  caller_flag = CASE WHEN k.l27_customer_id IS NULL AND k.l27_team_id IS NULL AND NOT x.linked THEN COALESCE(k.caller_flag, x.caller_flag) ELSE k.caller_flag END,
  notes = CASE WHEN x.notes IS NULL THEN k.notes WHEN NULLIF(btrim(k.notes), '') IS NULL THEN x.notes ELSE k.notes || E'\n\n' || x.notes END,
  updated_at = now()
FROM (
  SELECT m.keep,
         (array_agg(c.name ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.name), '') IS NOT NULL))[1] AS name,
         min(c.l27_customer_id) AS l27_customer_id,
         min(c.l27_team_id) AS l27_team_id,
         (array_agg(c.lead_stage ORDER BY c.id) FILTER (WHERE c.lead_stage IS NOT NULL))[1] AS lead_stage,
         (array_agg(c.lead_source ORDER BY c.id) FILTER (WHERE c.lead_source IS NOT NULL))[1] AS lead_source,
         (array_agg(c.communication_preference ORDER BY c.id) FILTER (WHERE c.communication_preference IS NOT NULL))[1] AS communication_preference,
         (array_agg(c.caller_flag ORDER BY c.id) FILTER (WHERE c.caller_flag IS NOT NULL))[1] AS caller_flag,
         bool_or(c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL) AS linked,
         string_agg(c.notes, E'\n\n' ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.notes), '') IS NOT NULL) AS notes
  FROM merge_map m JOIN contacts c ON c.id = m.drop_id
  GROUP BY m.keep
) x
WHERE k.id = x.keep;

UPDATE contacts k SET roles = r.roles
FROM (
  SELECT m.keep, jsonb_agg(DISTINCT e.v) AS roles
  FROM (SELECT DISTINCT keep, keep AS cid FROM merge_map UNION ALL SELECT keep, drop_id FROM merge_map) m
  JOIN contacts c ON c.id = m.cid
  CROSS JOIN LATERAL jsonb_array_elements(c.roles) e(v)
  GROUP BY m.keep
) r
WHERE k.id = r.keep;

UPDATE conversations v SET contact_id = m.keep FROM merge_map m WHERE v.contact_id = m.drop_id;
UPDATE complaint_cases x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
UPDATE kustomer_plan_customers x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
INSERT INTO contact_identity_removals (contact_id, kind, value, removed_at)
SELECT m.keep, r.kind, r.value, r.removed_at FROM merge_map m JOIN contact_identity_removals r ON r.contact_id = m.drop_id
ON CONFLICT (contact_id, kind, value) DO NOTHING;

-- One copy of each email or phone per kept contact (its own, else the oldest), then the rest move.
DELETE FROM contact_identities i USING (
  SELECT x.id, row_number() OVER (PARTITION BY g.keep, x.kind, x.value ORDER BY (x.contact_id = g.keep) DESC, x.id) AS rn
  FROM contact_identities x
  JOIN (SELECT drop_id AS cid, keep FROM merge_map UNION SELECT keep, keep FROM merge_map) g ON g.cid = x.contact_id
) r
WHERE r.id = i.id AND r.rn > 1;
UPDATE contact_identities i SET contact_id = m.keep FROM merge_map m WHERE i.contact_id = m.drop_id;

DELETE FROM contacts c USING merge_map m WHERE c.id = m.drop_id;
DELETE FROM merge_map;

-- ---------- 1b. the same Launch27 cleaner ----------

DELETE FROM keep_l27;
INSERT INTO keep_l27
SELECT DISTINCT ON (l27_team_id) l27_team_id, id, l27_customer_id
FROM contacts WHERE l27_team_id IS NOT NULL
ORDER BY l27_team_id, (l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(name), '') IS NOT NULL) DESC, id;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.unlinked', 'contact', c.id::text, jsonb_build_object('by', 'migration 0038: a different customer than the contact kept for this cleaner', 'l27_team_id', c.l27_team_id, 'kept_on', k.keep)
FROM contacts c JOIN keep_l27 k ON k.l27_id = c.l27_team_id
WHERE c.id <> k.keep AND c.l27_customer_id IS NOT NULL AND k.other IS NOT NULL AND c.l27_customer_id <> k.other;

UPDATE contacts c SET l27_team_id = NULL, updated_at = now()
FROM keep_l27 k
WHERE k.l27_id = c.l27_team_id AND c.id <> k.keep AND c.l27_customer_id IS NOT NULL AND k.other IS NOT NULL AND c.l27_customer_id <> k.other;

INSERT INTO merge_map
SELECT c.id, k.keep FROM contacts c JOIN keep_l27 k ON k.l27_id = c.l27_team_id WHERE c.id <> k.keep;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.merged', 'contact', m.keep::text,
       jsonb_build_object('by', 'migration 0038: one contact per Launch27 cleaner',
                          'merged', jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'roles', c.roles, 'l27_customer_id', c.l27_customer_id, 'l27_team_id', c.l27_team_id, 'lead_stage', c.lead_stage, 'lead_source', c.lead_source, 'caller_flag', c.caller_flag, 'notes', c.notes) ORDER BY c.id))
FROM merge_map m JOIN contacts c ON c.id = m.drop_id
GROUP BY m.keep;

UPDATE contacts k SET
  name = COALESCE(NULLIF(btrim(k.name), ''), x.name),
  l27_customer_id = COALESCE(k.l27_customer_id, x.l27_customer_id),
  l27_team_id = COALESCE(k.l27_team_id, x.l27_team_id),
  lead_stage = COALESCE(k.lead_stage, x.lead_stage),
  lead_source = COALESCE(k.lead_source, x.lead_source),
  communication_preference = COALESCE(k.communication_preference, x.communication_preference),
  caller_flag = CASE WHEN k.l27_customer_id IS NULL AND k.l27_team_id IS NULL AND NOT x.linked THEN COALESCE(k.caller_flag, x.caller_flag) ELSE k.caller_flag END,
  notes = CASE WHEN x.notes IS NULL THEN k.notes WHEN NULLIF(btrim(k.notes), '') IS NULL THEN x.notes ELSE k.notes || E'\n\n' || x.notes END,
  updated_at = now()
FROM (
  SELECT m.keep,
         (array_agg(c.name ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.name), '') IS NOT NULL))[1] AS name,
         min(c.l27_customer_id) AS l27_customer_id,
         min(c.l27_team_id) AS l27_team_id,
         (array_agg(c.lead_stage ORDER BY c.id) FILTER (WHERE c.lead_stage IS NOT NULL))[1] AS lead_stage,
         (array_agg(c.lead_source ORDER BY c.id) FILTER (WHERE c.lead_source IS NOT NULL))[1] AS lead_source,
         (array_agg(c.communication_preference ORDER BY c.id) FILTER (WHERE c.communication_preference IS NOT NULL))[1] AS communication_preference,
         (array_agg(c.caller_flag ORDER BY c.id) FILTER (WHERE c.caller_flag IS NOT NULL))[1] AS caller_flag,
         bool_or(c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL) AS linked,
         string_agg(c.notes, E'\n\n' ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.notes), '') IS NOT NULL) AS notes
  FROM merge_map m JOIN contacts c ON c.id = m.drop_id
  GROUP BY m.keep
) x
WHERE k.id = x.keep;

UPDATE contacts k SET roles = r.roles
FROM (
  SELECT m.keep, jsonb_agg(DISTINCT e.v) AS roles
  FROM (SELECT DISTINCT keep, keep AS cid FROM merge_map UNION ALL SELECT keep, drop_id FROM merge_map) m
  JOIN contacts c ON c.id = m.cid
  CROSS JOIN LATERAL jsonb_array_elements(c.roles) e(v)
  GROUP BY m.keep
) r
WHERE k.id = r.keep;

UPDATE conversations v SET contact_id = m.keep FROM merge_map m WHERE v.contact_id = m.drop_id;
UPDATE complaint_cases x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
UPDATE kustomer_plan_customers x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
INSERT INTO contact_identity_removals (contact_id, kind, value, removed_at)
SELECT m.keep, r.kind, r.value, r.removed_at FROM merge_map m JOIN contact_identity_removals r ON r.contact_id = m.drop_id
ON CONFLICT (contact_id, kind, value) DO NOTHING;

-- One copy of each email or phone per kept contact (its own, else the oldest), then the rest move.
DELETE FROM contact_identities i USING (
  SELECT x.id, row_number() OVER (PARTITION BY g.keep, x.kind, x.value ORDER BY (x.contact_id = g.keep) DESC, x.id) AS rn
  FROM contact_identities x
  JOIN (SELECT drop_id AS cid, keep FROM merge_map UNION SELECT keep, keep FROM merge_map) g ON g.cid = x.contact_id
) r
WHERE r.id = i.id AND r.rn > 1;
UPDATE contact_identities i SET contact_id = m.keep FROM merge_map m WHERE i.contact_id = m.drop_id;

DELETE FROM contacts c USING merge_map m WHERE c.id = m.drop_id;
DELETE FROM merge_map;

-- ---------- 2. the same email or phone (in rounds, so chains are followed) ----------
--
-- Each round: every shared email or phone that says who someone is (at most one Launch27
-- person among the contacts holding it) has an owner, the best contact holding it. A contact
-- with no Launch27 link points at the best owner of its shared values; owners always rank
-- better than what points at them, so following the pointers ends at the contact kept. Its
-- copies move with it, except a copy of a value whose owner is a Launch27 person elsewhere
-- (that person keeps it). A copy that moves can join two contacts the next round. Four rounds
-- cover any realistic chain; whatever is still shared afterwards is handled below.

CREATE TEMP TABLE contact_rank (id bigint PRIMARY KEY, rk bigint NOT NULL, linked boolean NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE value_owner (kind text NOT NULL, value text NOT NULL, owner bigint NOT NULL, owner_linked boolean NOT NULL, PRIMARY KEY (kind, value)) ON COMMIT DROP;
CREATE TEMP TABLE merge_parent (id bigint PRIMARY KEY, parent bigint NOT NULL) ON COMMIT DROP;

-- round 1
DELETE FROM contact_rank;
INSERT INTO contact_rank
SELECT c.id,
       row_number() OVER (ORDER BY (c.l27_team_id IS NOT NULL) DESC, (c.l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(c.name), '') IS NOT NULL) DESC, c.id),
       (c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL)
FROM contacts c
WHERE c.id IN (SELECT i.contact_id FROM contact_identities i WHERE (i.kind, i.value) IN (SELECT kind, value FROM contact_identities GROUP BY kind, value HAVING count(*) > 1));

DELETE FROM value_owner;
INSERT INTO value_owner
SELECT DISTINCT ON (i.kind, i.value) i.kind, i.value, i.contact_id, r.linked
FROM contact_identities i
JOIN contact_rank r ON r.id = i.contact_id
JOIN (SELECT x.kind, x.value FROM contact_identities x JOIN contact_rank xr ON xr.id = x.contact_id
      GROUP BY x.kind, x.value HAVING count(*) FILTER (WHERE xr.linked) <= 1) s ON s.kind = i.kind AND s.value = i.value
ORDER BY i.kind, i.value, r.rk;

DELETE FROM merge_parent;
INSERT INTO merge_parent
SELECT DISTINCT ON (i.contact_id) i.contact_id, o.owner
FROM contact_identities i
JOIN value_owner o ON o.kind = i.kind AND o.value = i.value AND o.owner <> i.contact_id
JOIN contact_rank me ON me.id = i.contact_id AND NOT me.linked
JOIN contact_rank ro ON ro.id = o.owner
ORDER BY i.contact_id, ro.rk;

INSERT INTO merge_map
WITH RECURSIVE up(id, top, depth) AS (
  SELECT id, parent, 1 FROM merge_parent
  UNION ALL
  SELECT up.id, p.parent, up.depth + 1 FROM up JOIN merge_parent p ON p.id = up.top WHERE up.depth < 1000
)
SELECT DISTINCT ON (up.id) up.id, up.top FROM up JOIN contact_rank r ON r.id = up.top ORDER BY up.id, r.rk;

DELETE FROM contact_identities i
USING merge_map m, value_owner o
WHERE i.contact_id = m.drop_id AND o.kind = i.kind AND o.value = i.value AND o.owner_linked AND o.owner <> m.keep;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.merged', 'contact', m.keep::text,
       jsonb_build_object('by', 'migration 0038: one contact per email or phone (round 1)',
                          'merged', jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'roles', c.roles, 'l27_customer_id', c.l27_customer_id, 'l27_team_id', c.l27_team_id, 'lead_stage', c.lead_stage, 'lead_source', c.lead_source, 'caller_flag', c.caller_flag, 'notes', c.notes) ORDER BY c.id))
FROM merge_map m JOIN contacts c ON c.id = m.drop_id
GROUP BY m.keep;

UPDATE contacts k SET
  name = COALESCE(NULLIF(btrim(k.name), ''), x.name),
  l27_customer_id = COALESCE(k.l27_customer_id, x.l27_customer_id),
  l27_team_id = COALESCE(k.l27_team_id, x.l27_team_id),
  lead_stage = COALESCE(k.lead_stage, x.lead_stage),
  lead_source = COALESCE(k.lead_source, x.lead_source),
  communication_preference = COALESCE(k.communication_preference, x.communication_preference),
  caller_flag = CASE WHEN k.l27_customer_id IS NULL AND k.l27_team_id IS NULL AND NOT x.linked THEN COALESCE(k.caller_flag, x.caller_flag) ELSE k.caller_flag END,
  notes = CASE WHEN x.notes IS NULL THEN k.notes WHEN NULLIF(btrim(k.notes), '') IS NULL THEN x.notes ELSE k.notes || E'\n\n' || x.notes END,
  updated_at = now()
FROM (
  SELECT m.keep,
         (array_agg(c.name ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.name), '') IS NOT NULL))[1] AS name,
         min(c.l27_customer_id) AS l27_customer_id,
         min(c.l27_team_id) AS l27_team_id,
         (array_agg(c.lead_stage ORDER BY c.id) FILTER (WHERE c.lead_stage IS NOT NULL))[1] AS lead_stage,
         (array_agg(c.lead_source ORDER BY c.id) FILTER (WHERE c.lead_source IS NOT NULL))[1] AS lead_source,
         (array_agg(c.communication_preference ORDER BY c.id) FILTER (WHERE c.communication_preference IS NOT NULL))[1] AS communication_preference,
         (array_agg(c.caller_flag ORDER BY c.id) FILTER (WHERE c.caller_flag IS NOT NULL))[1] AS caller_flag,
         bool_or(c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL) AS linked,
         string_agg(c.notes, E'\n\n' ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.notes), '') IS NOT NULL) AS notes
  FROM merge_map m JOIN contacts c ON c.id = m.drop_id
  GROUP BY m.keep
) x
WHERE k.id = x.keep;

UPDATE contacts k SET roles = r.roles
FROM (
  SELECT m.keep, jsonb_agg(DISTINCT e.v) AS roles
  FROM (SELECT DISTINCT keep, keep AS cid FROM merge_map UNION ALL SELECT keep, drop_id FROM merge_map) m
  JOIN contacts c ON c.id = m.cid
  CROSS JOIN LATERAL jsonb_array_elements(c.roles) e(v)
  GROUP BY m.keep
) r
WHERE k.id = r.keep;

UPDATE conversations v SET contact_id = m.keep FROM merge_map m WHERE v.contact_id = m.drop_id;
UPDATE complaint_cases x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
UPDATE kustomer_plan_customers x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
INSERT INTO contact_identity_removals (contact_id, kind, value, removed_at)
SELECT m.keep, r.kind, r.value, r.removed_at FROM merge_map m JOIN contact_identity_removals r ON r.contact_id = m.drop_id
ON CONFLICT (contact_id, kind, value) DO NOTHING;

-- One copy of each email or phone per kept contact (its own, else the oldest), then the rest move.
DELETE FROM contact_identities i USING (
  SELECT x.id, row_number() OVER (PARTITION BY g.keep, x.kind, x.value ORDER BY (x.contact_id = g.keep) DESC, x.id) AS rn
  FROM contact_identities x
  JOIN (SELECT drop_id AS cid, keep FROM merge_map UNION SELECT keep, keep FROM merge_map) g ON g.cid = x.contact_id
) r
WHERE r.id = i.id AND r.rn > 1;
UPDATE contact_identities i SET contact_id = m.keep FROM merge_map m WHERE i.contact_id = m.drop_id;

DELETE FROM contacts c USING merge_map m WHERE c.id = m.drop_id;
DELETE FROM merge_map;

-- round 2
DELETE FROM contact_rank;
INSERT INTO contact_rank
SELECT c.id,
       row_number() OVER (ORDER BY (c.l27_team_id IS NOT NULL) DESC, (c.l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(c.name), '') IS NOT NULL) DESC, c.id),
       (c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL)
FROM contacts c
WHERE c.id IN (SELECT i.contact_id FROM contact_identities i WHERE (i.kind, i.value) IN (SELECT kind, value FROM contact_identities GROUP BY kind, value HAVING count(*) > 1));

DELETE FROM value_owner;
INSERT INTO value_owner
SELECT DISTINCT ON (i.kind, i.value) i.kind, i.value, i.contact_id, r.linked
FROM contact_identities i
JOIN contact_rank r ON r.id = i.contact_id
JOIN (SELECT x.kind, x.value FROM contact_identities x JOIN contact_rank xr ON xr.id = x.contact_id
      GROUP BY x.kind, x.value HAVING count(*) FILTER (WHERE xr.linked) <= 1) s ON s.kind = i.kind AND s.value = i.value
ORDER BY i.kind, i.value, r.rk;

DELETE FROM merge_parent;
INSERT INTO merge_parent
SELECT DISTINCT ON (i.contact_id) i.contact_id, o.owner
FROM contact_identities i
JOIN value_owner o ON o.kind = i.kind AND o.value = i.value AND o.owner <> i.contact_id
JOIN contact_rank me ON me.id = i.contact_id AND NOT me.linked
JOIN contact_rank ro ON ro.id = o.owner
ORDER BY i.contact_id, ro.rk;

INSERT INTO merge_map
WITH RECURSIVE up(id, top, depth) AS (
  SELECT id, parent, 1 FROM merge_parent
  UNION ALL
  SELECT up.id, p.parent, up.depth + 1 FROM up JOIN merge_parent p ON p.id = up.top WHERE up.depth < 1000
)
SELECT DISTINCT ON (up.id) up.id, up.top FROM up JOIN contact_rank r ON r.id = up.top ORDER BY up.id, r.rk;

DELETE FROM contact_identities i
USING merge_map m, value_owner o
WHERE i.contact_id = m.drop_id AND o.kind = i.kind AND o.value = i.value AND o.owner_linked AND o.owner <> m.keep;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.merged', 'contact', m.keep::text,
       jsonb_build_object('by', 'migration 0038: one contact per email or phone (round 2)',
                          'merged', jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'roles', c.roles, 'l27_customer_id', c.l27_customer_id, 'l27_team_id', c.l27_team_id, 'lead_stage', c.lead_stage, 'lead_source', c.lead_source, 'caller_flag', c.caller_flag, 'notes', c.notes) ORDER BY c.id))
FROM merge_map m JOIN contacts c ON c.id = m.drop_id
GROUP BY m.keep;

UPDATE contacts k SET
  name = COALESCE(NULLIF(btrim(k.name), ''), x.name),
  l27_customer_id = COALESCE(k.l27_customer_id, x.l27_customer_id),
  l27_team_id = COALESCE(k.l27_team_id, x.l27_team_id),
  lead_stage = COALESCE(k.lead_stage, x.lead_stage),
  lead_source = COALESCE(k.lead_source, x.lead_source),
  communication_preference = COALESCE(k.communication_preference, x.communication_preference),
  caller_flag = CASE WHEN k.l27_customer_id IS NULL AND k.l27_team_id IS NULL AND NOT x.linked THEN COALESCE(k.caller_flag, x.caller_flag) ELSE k.caller_flag END,
  notes = CASE WHEN x.notes IS NULL THEN k.notes WHEN NULLIF(btrim(k.notes), '') IS NULL THEN x.notes ELSE k.notes || E'\n\n' || x.notes END,
  updated_at = now()
FROM (
  SELECT m.keep,
         (array_agg(c.name ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.name), '') IS NOT NULL))[1] AS name,
         min(c.l27_customer_id) AS l27_customer_id,
         min(c.l27_team_id) AS l27_team_id,
         (array_agg(c.lead_stage ORDER BY c.id) FILTER (WHERE c.lead_stage IS NOT NULL))[1] AS lead_stage,
         (array_agg(c.lead_source ORDER BY c.id) FILTER (WHERE c.lead_source IS NOT NULL))[1] AS lead_source,
         (array_agg(c.communication_preference ORDER BY c.id) FILTER (WHERE c.communication_preference IS NOT NULL))[1] AS communication_preference,
         (array_agg(c.caller_flag ORDER BY c.id) FILTER (WHERE c.caller_flag IS NOT NULL))[1] AS caller_flag,
         bool_or(c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL) AS linked,
         string_agg(c.notes, E'\n\n' ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.notes), '') IS NOT NULL) AS notes
  FROM merge_map m JOIN contacts c ON c.id = m.drop_id
  GROUP BY m.keep
) x
WHERE k.id = x.keep;

UPDATE contacts k SET roles = r.roles
FROM (
  SELECT m.keep, jsonb_agg(DISTINCT e.v) AS roles
  FROM (SELECT DISTINCT keep, keep AS cid FROM merge_map UNION ALL SELECT keep, drop_id FROM merge_map) m
  JOIN contacts c ON c.id = m.cid
  CROSS JOIN LATERAL jsonb_array_elements(c.roles) e(v)
  GROUP BY m.keep
) r
WHERE k.id = r.keep;

UPDATE conversations v SET contact_id = m.keep FROM merge_map m WHERE v.contact_id = m.drop_id;
UPDATE complaint_cases x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
UPDATE kustomer_plan_customers x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
INSERT INTO contact_identity_removals (contact_id, kind, value, removed_at)
SELECT m.keep, r.kind, r.value, r.removed_at FROM merge_map m JOIN contact_identity_removals r ON r.contact_id = m.drop_id
ON CONFLICT (contact_id, kind, value) DO NOTHING;

-- One copy of each email or phone per kept contact (its own, else the oldest), then the rest move.
DELETE FROM contact_identities i USING (
  SELECT x.id, row_number() OVER (PARTITION BY g.keep, x.kind, x.value ORDER BY (x.contact_id = g.keep) DESC, x.id) AS rn
  FROM contact_identities x
  JOIN (SELECT drop_id AS cid, keep FROM merge_map UNION SELECT keep, keep FROM merge_map) g ON g.cid = x.contact_id
) r
WHERE r.id = i.id AND r.rn > 1;
UPDATE contact_identities i SET contact_id = m.keep FROM merge_map m WHERE i.contact_id = m.drop_id;

DELETE FROM contacts c USING merge_map m WHERE c.id = m.drop_id;
DELETE FROM merge_map;

-- round 3
DELETE FROM contact_rank;
INSERT INTO contact_rank
SELECT c.id,
       row_number() OVER (ORDER BY (c.l27_team_id IS NOT NULL) DESC, (c.l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(c.name), '') IS NOT NULL) DESC, c.id),
       (c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL)
FROM contacts c
WHERE c.id IN (SELECT i.contact_id FROM contact_identities i WHERE (i.kind, i.value) IN (SELECT kind, value FROM contact_identities GROUP BY kind, value HAVING count(*) > 1));

DELETE FROM value_owner;
INSERT INTO value_owner
SELECT DISTINCT ON (i.kind, i.value) i.kind, i.value, i.contact_id, r.linked
FROM contact_identities i
JOIN contact_rank r ON r.id = i.contact_id
JOIN (SELECT x.kind, x.value FROM contact_identities x JOIN contact_rank xr ON xr.id = x.contact_id
      GROUP BY x.kind, x.value HAVING count(*) FILTER (WHERE xr.linked) <= 1) s ON s.kind = i.kind AND s.value = i.value
ORDER BY i.kind, i.value, r.rk;

DELETE FROM merge_parent;
INSERT INTO merge_parent
SELECT DISTINCT ON (i.contact_id) i.contact_id, o.owner
FROM contact_identities i
JOIN value_owner o ON o.kind = i.kind AND o.value = i.value AND o.owner <> i.contact_id
JOIN contact_rank me ON me.id = i.contact_id AND NOT me.linked
JOIN contact_rank ro ON ro.id = o.owner
ORDER BY i.contact_id, ro.rk;

INSERT INTO merge_map
WITH RECURSIVE up(id, top, depth) AS (
  SELECT id, parent, 1 FROM merge_parent
  UNION ALL
  SELECT up.id, p.parent, up.depth + 1 FROM up JOIN merge_parent p ON p.id = up.top WHERE up.depth < 1000
)
SELECT DISTINCT ON (up.id) up.id, up.top FROM up JOIN contact_rank r ON r.id = up.top ORDER BY up.id, r.rk;

DELETE FROM contact_identities i
USING merge_map m, value_owner o
WHERE i.contact_id = m.drop_id AND o.kind = i.kind AND o.value = i.value AND o.owner_linked AND o.owner <> m.keep;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.merged', 'contact', m.keep::text,
       jsonb_build_object('by', 'migration 0038: one contact per email or phone (round 3)',
                          'merged', jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'roles', c.roles, 'l27_customer_id', c.l27_customer_id, 'l27_team_id', c.l27_team_id, 'lead_stage', c.lead_stage, 'lead_source', c.lead_source, 'caller_flag', c.caller_flag, 'notes', c.notes) ORDER BY c.id))
FROM merge_map m JOIN contacts c ON c.id = m.drop_id
GROUP BY m.keep;

UPDATE contacts k SET
  name = COALESCE(NULLIF(btrim(k.name), ''), x.name),
  l27_customer_id = COALESCE(k.l27_customer_id, x.l27_customer_id),
  l27_team_id = COALESCE(k.l27_team_id, x.l27_team_id),
  lead_stage = COALESCE(k.lead_stage, x.lead_stage),
  lead_source = COALESCE(k.lead_source, x.lead_source),
  communication_preference = COALESCE(k.communication_preference, x.communication_preference),
  caller_flag = CASE WHEN k.l27_customer_id IS NULL AND k.l27_team_id IS NULL AND NOT x.linked THEN COALESCE(k.caller_flag, x.caller_flag) ELSE k.caller_flag END,
  notes = CASE WHEN x.notes IS NULL THEN k.notes WHEN NULLIF(btrim(k.notes), '') IS NULL THEN x.notes ELSE k.notes || E'\n\n' || x.notes END,
  updated_at = now()
FROM (
  SELECT m.keep,
         (array_agg(c.name ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.name), '') IS NOT NULL))[1] AS name,
         min(c.l27_customer_id) AS l27_customer_id,
         min(c.l27_team_id) AS l27_team_id,
         (array_agg(c.lead_stage ORDER BY c.id) FILTER (WHERE c.lead_stage IS NOT NULL))[1] AS lead_stage,
         (array_agg(c.lead_source ORDER BY c.id) FILTER (WHERE c.lead_source IS NOT NULL))[1] AS lead_source,
         (array_agg(c.communication_preference ORDER BY c.id) FILTER (WHERE c.communication_preference IS NOT NULL))[1] AS communication_preference,
         (array_agg(c.caller_flag ORDER BY c.id) FILTER (WHERE c.caller_flag IS NOT NULL))[1] AS caller_flag,
         bool_or(c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL) AS linked,
         string_agg(c.notes, E'\n\n' ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.notes), '') IS NOT NULL) AS notes
  FROM merge_map m JOIN contacts c ON c.id = m.drop_id
  GROUP BY m.keep
) x
WHERE k.id = x.keep;

UPDATE contacts k SET roles = r.roles
FROM (
  SELECT m.keep, jsonb_agg(DISTINCT e.v) AS roles
  FROM (SELECT DISTINCT keep, keep AS cid FROM merge_map UNION ALL SELECT keep, drop_id FROM merge_map) m
  JOIN contacts c ON c.id = m.cid
  CROSS JOIN LATERAL jsonb_array_elements(c.roles) e(v)
  GROUP BY m.keep
) r
WHERE k.id = r.keep;

UPDATE conversations v SET contact_id = m.keep FROM merge_map m WHERE v.contact_id = m.drop_id;
UPDATE complaint_cases x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
UPDATE kustomer_plan_customers x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
INSERT INTO contact_identity_removals (contact_id, kind, value, removed_at)
SELECT m.keep, r.kind, r.value, r.removed_at FROM merge_map m JOIN contact_identity_removals r ON r.contact_id = m.drop_id
ON CONFLICT (contact_id, kind, value) DO NOTHING;

-- One copy of each email or phone per kept contact (its own, else the oldest), then the rest move.
DELETE FROM contact_identities i USING (
  SELECT x.id, row_number() OVER (PARTITION BY g.keep, x.kind, x.value ORDER BY (x.contact_id = g.keep) DESC, x.id) AS rn
  FROM contact_identities x
  JOIN (SELECT drop_id AS cid, keep FROM merge_map UNION SELECT keep, keep FROM merge_map) g ON g.cid = x.contact_id
) r
WHERE r.id = i.id AND r.rn > 1;
UPDATE contact_identities i SET contact_id = m.keep FROM merge_map m WHERE i.contact_id = m.drop_id;

DELETE FROM contacts c USING merge_map m WHERE c.id = m.drop_id;
DELETE FROM merge_map;

-- round 4
DELETE FROM contact_rank;
INSERT INTO contact_rank
SELECT c.id,
       row_number() OVER (ORDER BY (c.l27_team_id IS NOT NULL) DESC, (c.l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(c.name), '') IS NOT NULL) DESC, c.id),
       (c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL)
FROM contacts c
WHERE c.id IN (SELECT i.contact_id FROM contact_identities i WHERE (i.kind, i.value) IN (SELECT kind, value FROM contact_identities GROUP BY kind, value HAVING count(*) > 1));

DELETE FROM value_owner;
INSERT INTO value_owner
SELECT DISTINCT ON (i.kind, i.value) i.kind, i.value, i.contact_id, r.linked
FROM contact_identities i
JOIN contact_rank r ON r.id = i.contact_id
JOIN (SELECT x.kind, x.value FROM contact_identities x JOIN contact_rank xr ON xr.id = x.contact_id
      GROUP BY x.kind, x.value HAVING count(*) FILTER (WHERE xr.linked) <= 1) s ON s.kind = i.kind AND s.value = i.value
ORDER BY i.kind, i.value, r.rk;

DELETE FROM merge_parent;
INSERT INTO merge_parent
SELECT DISTINCT ON (i.contact_id) i.contact_id, o.owner
FROM contact_identities i
JOIN value_owner o ON o.kind = i.kind AND o.value = i.value AND o.owner <> i.contact_id
JOIN contact_rank me ON me.id = i.contact_id AND NOT me.linked
JOIN contact_rank ro ON ro.id = o.owner
ORDER BY i.contact_id, ro.rk;

INSERT INTO merge_map
WITH RECURSIVE up(id, top, depth) AS (
  SELECT id, parent, 1 FROM merge_parent
  UNION ALL
  SELECT up.id, p.parent, up.depth + 1 FROM up JOIN merge_parent p ON p.id = up.top WHERE up.depth < 1000
)
SELECT DISTINCT ON (up.id) up.id, up.top FROM up JOIN contact_rank r ON r.id = up.top ORDER BY up.id, r.rk;

DELETE FROM contact_identities i
USING merge_map m, value_owner o
WHERE i.contact_id = m.drop_id AND o.kind = i.kind AND o.value = i.value AND o.owner_linked AND o.owner <> m.keep;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.merged', 'contact', m.keep::text,
       jsonb_build_object('by', 'migration 0038: one contact per email or phone (round 4)',
                          'merged', jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'roles', c.roles, 'l27_customer_id', c.l27_customer_id, 'l27_team_id', c.l27_team_id, 'lead_stage', c.lead_stage, 'lead_source', c.lead_source, 'caller_flag', c.caller_flag, 'notes', c.notes) ORDER BY c.id))
FROM merge_map m JOIN contacts c ON c.id = m.drop_id
GROUP BY m.keep;

UPDATE contacts k SET
  name = COALESCE(NULLIF(btrim(k.name), ''), x.name),
  l27_customer_id = COALESCE(k.l27_customer_id, x.l27_customer_id),
  l27_team_id = COALESCE(k.l27_team_id, x.l27_team_id),
  lead_stage = COALESCE(k.lead_stage, x.lead_stage),
  lead_source = COALESCE(k.lead_source, x.lead_source),
  communication_preference = COALESCE(k.communication_preference, x.communication_preference),
  caller_flag = CASE WHEN k.l27_customer_id IS NULL AND k.l27_team_id IS NULL AND NOT x.linked THEN COALESCE(k.caller_flag, x.caller_flag) ELSE k.caller_flag END,
  notes = CASE WHEN x.notes IS NULL THEN k.notes WHEN NULLIF(btrim(k.notes), '') IS NULL THEN x.notes ELSE k.notes || E'\n\n' || x.notes END,
  updated_at = now()
FROM (
  SELECT m.keep,
         (array_agg(c.name ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.name), '') IS NOT NULL))[1] AS name,
         min(c.l27_customer_id) AS l27_customer_id,
         min(c.l27_team_id) AS l27_team_id,
         (array_agg(c.lead_stage ORDER BY c.id) FILTER (WHERE c.lead_stage IS NOT NULL))[1] AS lead_stage,
         (array_agg(c.lead_source ORDER BY c.id) FILTER (WHERE c.lead_source IS NOT NULL))[1] AS lead_source,
         (array_agg(c.communication_preference ORDER BY c.id) FILTER (WHERE c.communication_preference IS NOT NULL))[1] AS communication_preference,
         (array_agg(c.caller_flag ORDER BY c.id) FILTER (WHERE c.caller_flag IS NOT NULL))[1] AS caller_flag,
         bool_or(c.l27_customer_id IS NOT NULL OR c.l27_team_id IS NOT NULL) AS linked,
         string_agg(c.notes, E'\n\n' ORDER BY c.id) FILTER (WHERE NULLIF(btrim(c.notes), '') IS NOT NULL) AS notes
  FROM merge_map m JOIN contacts c ON c.id = m.drop_id
  GROUP BY m.keep
) x
WHERE k.id = x.keep;

UPDATE contacts k SET roles = r.roles
FROM (
  SELECT m.keep, jsonb_agg(DISTINCT e.v) AS roles
  FROM (SELECT DISTINCT keep, keep AS cid FROM merge_map UNION ALL SELECT keep, drop_id FROM merge_map) m
  JOIN contacts c ON c.id = m.cid
  CROSS JOIN LATERAL jsonb_array_elements(c.roles) e(v)
  GROUP BY m.keep
) r
WHERE k.id = r.keep;

UPDATE conversations v SET contact_id = m.keep FROM merge_map m WHERE v.contact_id = m.drop_id;
UPDATE complaint_cases x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
UPDATE kustomer_plan_customers x SET contact_id = m.keep FROM merge_map m WHERE x.contact_id = m.drop_id;
INSERT INTO contact_identity_removals (contact_id, kind, value, removed_at)
SELECT m.keep, r.kind, r.value, r.removed_at FROM merge_map m JOIN contact_identity_removals r ON r.contact_id = m.drop_id
ON CONFLICT (contact_id, kind, value) DO NOTHING;

-- One copy of each email or phone per kept contact (its own, else the oldest), then the rest move.
DELETE FROM contact_identities i USING (
  SELECT x.id, row_number() OVER (PARTITION BY g.keep, x.kind, x.value ORDER BY (x.contact_id = g.keep) DESC, x.id) AS rn
  FROM contact_identities x
  JOIN (SELECT drop_id AS cid, keep FROM merge_map UNION SELECT keep, keep FROM merge_map) g ON g.cid = x.contact_id
) r
WHERE r.id = i.id AND r.rn > 1;
UPDATE contact_identities i SET contact_id = m.keep FROM merge_map m WHERE i.contact_id = m.drop_id;

DELETE FROM contacts c USING merge_map m WHERE c.id = m.drop_id;
DELETE FROM merge_map;

-- ---------- what is still shared: only Launch27 people now ----------

CREATE TEMP TABLE identity_rank ON COMMIT DROP AS
SELECT x.id, x.contact_id, x.kind, x.value,
       row_number() OVER (PARTITION BY x.kind, x.value ORDER BY (c.l27_team_id IS NOT NULL) DESC, (c.l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(c.name), '') IS NOT NULL) DESC, c.id) AS rn
FROM contact_identities x JOIN contacts c ON c.id = x.contact_id
WHERE (x.kind, x.value) IN (SELECT kind, value FROM contact_identities GROUP BY kind, value HAVING count(*) > 1);

CREATE TEMP TABLE identity_extra ON COMMIT DROP AS
SELECT e.id, e.contact_id, e.kind, e.value, k.contact_id AS kept_on
FROM identity_rank e JOIN identity_rank k ON k.kind = e.kind AND k.value = e.value AND k.rn = 1
WHERE e.rn > 1;
ANALYZE identity_extra;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'identity.deduplicated', 'contact', e.contact_id::text,
       jsonb_build_object('by', 'migration 0038: an email or phone on several Launch27 people stays on one', 'kind', e.kind, 'value', e.value, 'kept_on', e.kept_on)
FROM identity_extra e;

-- A contact with no Launch27 link says where its email or phone went (it may have no other).
CREATE TEMP TABLE lost_note ON COMMIT DROP AS
SELECT e.contact_id, string_agg(e.value || ' was also on contact #' || e.kept_on || ' and now stays only there.', E'\n' ORDER BY e.value) AS note
FROM identity_extra e JOIN contacts c ON c.id = e.contact_id
WHERE c.l27_customer_id IS NULL AND c.l27_team_id IS NULL
GROUP BY e.contact_id;
ANALYZE lost_note;
UPDATE contacts c SET notes = concat_ws(E'\n\n', NULLIF(btrim(c.notes), ''), x.note), updated_at = now()
FROM lost_note x WHERE c.id = x.contact_id;

DELETE FROM contact_identities i USING identity_extra e WHERE i.id = e.id;

-- ---------- retire "Who is this?" ----------

UPDATE conversations v SET contact_id = i.contact_id
FROM contact_identities i
WHERE v.needs_match AND v.contact_id IS NULL AND i.value = v.their_identity
  AND i.kind = CASE WHEN v.channel IN ('email', 'chat') THEN 'email' ELSE 'phone' END;

UPDATE conversations SET needs_match = false WHERE needs_match;

-- ---------- keep it that way ----------

CREATE UNIQUE INDEX IF NOT EXISTS contact_identities_one_contact ON contact_identities (kind, value);
DROP INDEX IF EXISTS identities_lookup;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_one_per_l27_customer ON contacts (l27_customer_id) WHERE l27_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_one_per_l27_team ON contacts (l27_team_id) WHERE l27_team_id IS NOT NULL;
DROP INDEX IF EXISTS contacts_l27_customer;
DROP INDEX IF EXISTS contacts_l27_team;
