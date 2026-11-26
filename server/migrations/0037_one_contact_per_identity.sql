-- One contact per person: an email address or phone number belongs to one contact only, and a
-- Launch27 customer or cleaner has one contact only. Existing duplicates are merged here, and
-- unique indexes keep it that way. "Who is this?" (conversations.needs_match) is retired:
-- unknown senders simply become new contacts. The needs_match column is left in place (always
-- false from now on) so the previous release keeps working during a deploy or a rollback.
--
-- How duplicates are merged (each merge is written to audit_log as contact.merged):
--   1. contacts linked to the same Launch27 customer, or the same Launch27 cleaner;
--   2. contacts sharing an email or phone, directly or through each other, unless they are
--      linked to two different Launch27 customers (or cleaners): those are different people,
--      so the shared email or phone stays on one of them only (audited as identity.deduplicated).
-- The contact kept is the one linked to a cleaner, else to a customer, else the one with a
-- name, else the oldest. It keeps its own details and takes the others' where it has none
-- (notes are joined; a spam or wrong-number mark is never copied onto a Launch27 contact).
-- Conversations and complaint cases move to it; emails and phones move to it, and a number
-- that replied STOP on any copy stays opted out.

CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone text PRIMARY KEY,                         -- E.164; a STOP kept while no contact has the number
  opted_out_at timestamptz NOT NULL DEFAULT now()
);

-- Emails and phones an agent removed from a contact, so the refresh from Launch27 (customer
-- and cleaner pages) doesn't put them back.
CREATE TABLE IF NOT EXISTS contact_identity_removals (
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  value text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, kind, value)
);

-- A STOP on any copy of a number counts for every copy.
UPDATE contact_identities i SET opted_out = true, opted_out_at = COALESCE(i.opted_out_at, o.at, now())
FROM (SELECT kind, value, max(opted_out_at) AS at FROM contact_identities WHERE opted_out GROUP BY kind, value) o
WHERE NOT i.opted_out AND i.kind = o.kind AND i.value = o.value;

CREATE TEMP TABLE merge_edges (a bigint NOT NULL, b bigint NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE merge_groups (contact_id bigint PRIMARY KEY, grp bigint NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE merge_map (drop_id bigint PRIMARY KEY, keep bigint NOT NULL) ON COMMIT DROP;

-- ---------- phase 1: the same Launch27 customer or cleaner ----------

-- Each contact is linked to the first contact with the same value (and back), not to every
-- other one, so a value shared by many contacts stays cheap to group.
INSERT INTO merge_edges
SELECT c.id, r.root FROM contacts c
JOIN (SELECT l27_customer_id, min(id) AS root FROM contacts WHERE l27_customer_id IS NOT NULL GROUP BY l27_customer_id HAVING count(*) > 1) r ON r.l27_customer_id = c.l27_customer_id
WHERE c.id <> r.root
UNION
SELECT c.id, r.root FROM contacts c
JOIN (SELECT l27_team_id, min(id) AS root FROM contacts WHERE l27_team_id IS NOT NULL GROUP BY l27_team_id HAVING count(*) > 1) r ON r.l27_team_id = c.l27_team_id
WHERE c.id <> r.root;
INSERT INTO merge_edges SELECT b, a FROM merge_edges;

INSERT INTO merge_groups
WITH RECURSIVE reach(c, r) AS (
  SELECT a, a FROM merge_edges
  UNION
  SELECT reach.c, e.b FROM reach JOIN merge_edges e ON e.a = reach.r
)
SELECT c, min(r) FROM reach GROUP BY c;

INSERT INTO merge_map
SELECT g.contact_id, k.keep
FROM merge_groups g
JOIN (
  SELECT DISTINCT ON (g2.grp) g2.grp, g2.contact_id AS keep
  FROM merge_groups g2 JOIN contacts c ON c.id = g2.contact_id
  ORDER BY g2.grp, (c.l27_team_id IS NOT NULL) DESC, (c.l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(c.name), '') IS NOT NULL) DESC, c.id
) k ON k.grp = g.grp
WHERE g.contact_id <> k.keep;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.merged', 'contact', m.keep::text,
       jsonb_build_object('by', 'migration 0037: one contact per Launch27 customer or cleaner',
                          'merged', jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'l27_customer_id', c.l27_customer_id, 'l27_team_id', c.l27_team_id, 'lead_stage', c.lead_stage, 'caller_flag', c.caller_flag) ORDER BY c.id))
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

INSERT INTO contact_identities (contact_id, kind, value, label, opted_out, opted_out_at)
SELECT m.keep, i.kind, i.value, (array_agg(i.label ORDER BY i.id) FILTER (WHERE i.label IS NOT NULL))[1], bool_or(i.opted_out), max(i.opted_out_at)
FROM merge_map m JOIN contact_identities i ON i.contact_id = m.drop_id
GROUP BY m.keep, i.kind, i.value
ON CONFLICT (contact_id, kind, value) DO UPDATE SET
  label = COALESCE(contact_identities.label, EXCLUDED.label),
  opted_out = contact_identities.opted_out OR EXCLUDED.opted_out,
  opted_out_at = CASE WHEN contact_identities.opted_out THEN contact_identities.opted_out_at ELSE EXCLUDED.opted_out_at END;

DELETE FROM contacts c USING merge_map m WHERE c.id = m.drop_id;

-- ---------- phase 2: the same email or phone ----------

DELETE FROM merge_edges;
DELETE FROM merge_groups;
DELETE FROM merge_map;

INSERT INTO merge_edges
SELECT DISTINCT i.contact_id, r.root FROM contact_identities i
JOIN (SELECT kind, value, min(contact_id) AS root FROM contact_identities GROUP BY kind, value HAVING count(*) > 1) r ON r.kind = i.kind AND r.value = i.value
WHERE i.contact_id <> r.root;
INSERT INTO merge_edges SELECT b, a FROM merge_edges;

INSERT INTO merge_groups
WITH RECURSIVE reach(c, r) AS (
  SELECT a, a FROM merge_edges
  UNION
  SELECT reach.c, e.b FROM reach JOIN merge_edges e ON e.a = reach.r
)
SELECT c, min(r) FROM reach GROUP BY c;

-- Groups with two different Launch27 customers (or cleaners) are not merged.
INSERT INTO merge_map
SELECT g.contact_id, k.keep
FROM merge_groups g
JOIN (
  SELECT g3.grp FROM merge_groups g3 JOIN contacts c ON c.id = g3.contact_id
  GROUP BY g3.grp HAVING count(DISTINCT c.l27_customer_id) <= 1 AND count(DISTINCT c.l27_team_id) <= 1
) ok ON ok.grp = g.grp
JOIN (
  SELECT DISTINCT ON (g2.grp) g2.grp, g2.contact_id AS keep
  FROM merge_groups g2 JOIN contacts c ON c.id = g2.contact_id
  ORDER BY g2.grp, (c.l27_team_id IS NOT NULL) DESC, (c.l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(c.name), '') IS NOT NULL) DESC, c.id
) k ON k.grp = g.grp
WHERE g.contact_id <> k.keep;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'contact.merged', 'contact', m.keep::text,
       jsonb_build_object('by', 'migration 0037: one contact per email or phone',
                          'merged', jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'l27_customer_id', c.l27_customer_id, 'l27_team_id', c.l27_team_id, 'lead_stage', c.lead_stage, 'caller_flag', c.caller_flag) ORDER BY c.id))
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

INSERT INTO contact_identities (contact_id, kind, value, label, opted_out, opted_out_at)
SELECT m.keep, i.kind, i.value, (array_agg(i.label ORDER BY i.id) FILTER (WHERE i.label IS NOT NULL))[1], bool_or(i.opted_out), max(i.opted_out_at)
FROM merge_map m JOIN contact_identities i ON i.contact_id = m.drop_id
GROUP BY m.keep, i.kind, i.value
ON CONFLICT (contact_id, kind, value) DO UPDATE SET
  label = COALESCE(contact_identities.label, EXCLUDED.label),
  opted_out = contact_identities.opted_out OR EXCLUDED.opted_out,
  opted_out_at = CASE WHEN contact_identities.opted_out THEN contact_identities.opted_out_at ELSE EXCLUDED.opted_out_at END;

DELETE FROM contacts c USING merge_map m WHERE c.id = m.drop_id;

-- Left over: an email or phone shared by two different Launch27 customers or cleaners. It stays
-- on the contact that would have been kept, and comes off the others.
CREATE TEMP TABLE identity_extra ON COMMIT DROP AS
SELECT r.id, r.contact_id, r.kind, r.value FROM (
  SELECT x.id, x.contact_id, x.kind, x.value,
         row_number() OVER (PARTITION BY x.kind, x.value ORDER BY (c.l27_team_id IS NOT NULL) DESC, (c.l27_customer_id IS NOT NULL) DESC, (NULLIF(btrim(c.name), '') IS NOT NULL) DESC, c.id) AS rn
  FROM contact_identities x JOIN contacts c ON c.id = x.contact_id
) r
WHERE r.rn > 1;

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'identity.deduplicated', 'contact', e.contact_id::text,
       jsonb_build_object('by', 'migration 0037: one contact per email or phone', 'kind', e.kind, 'value', e.value,
                          'kept_on', (SELECT k.contact_id FROM contact_identities k WHERE k.kind = e.kind AND k.value = e.value AND k.id NOT IN (SELECT id FROM identity_extra) LIMIT 1))
FROM identity_extra e;

DELETE FROM contact_identities i USING identity_extra e WHERE i.id = e.id;

-- ---------- retire "Who is this?" ----------

-- A conversation that was waiting for an agent to pick between contacts goes to the one
-- contact that now has the address or number.
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
