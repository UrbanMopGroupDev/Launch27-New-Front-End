-- Queues, routing rules and teams as they are in Kustomer (routing export of Nov 25, 2026),
-- for databases seeded before it. New databases get the same from server/src/inbox/seed.js
-- and workforce.js, so queue, rule and team changes only run where queues already exist.
--   1. Queues take Kustomer's names and descriptions, and Kustomer's other live queues are
--      added. Hiring merges into HR Queue (Kustomer has one HR Queue): its conversations,
--      direct members and overflow settings move there.
--   2. Routing rules are replaced (Kustomer's queue rules, plus the rules that came from
--      Kustomer business rules). The old list is kept in the change history (detail.before).
--   3. Teams become Kustomer's 18 routing teams and the queues each one works. Members of
--      the five old default teams move to the team(s) that now work the same queues, then
--      those five are removed (kept in the change history first). Other teams stay.
--   4. Three agents are added so admins can put them on teams before they first sign in.
-- Data below is generated from seed.js and workforce.js. The runner splits statements on
-- semicolons and strips double dashes, so neither may appear inside a quoted value.

CREATE TEMP TABLE kustomer_seeded ON COMMIT DROP AS SELECT EXISTS (SELECT 1 FROM queues) AS yes;

CREATE TEMP TABLE kustomer_queues (slug text, name text, description text, restricted boolean, position int) ON COMMIT DROP;
INSERT INTO kustomer_queues VALUES
  ('operations', 'Operations Queue', 'Email, SMS, Chat, Phone', false, 0),
  ('sales', 'Sales Queue', 'Quotes, new inquiries, chat, Facebook and Instagram leads, lead follow-up', false, 1),
  ('sales-overflow', 'Sales Overflow(Cart Abandonment)', 'Cart abandonment emails', false, 2),
  ('customer-success', 'Customer Success', 'Queue for Customer Success', false, 3),
  ('billing', 'Billing Queue', 'This queue is for daily operations related to financial tasks such as charges not being held, any failed payments or outstanding payments from UM Portal in addition to any billing related tasks such as billing and invoices (receivables and payables).', false, 4),
  ('financial-operations', 'Financial Operations', 'This queue is strictly for daily operations related to financial tasks such as charges not being held, any failed payments or outstanding payments from UM Portal', false, 5),
  ('accounts-receivables', 'Accounts Receivables', 'It is the queue that will be used to route all receivable confirmations', false, 6),
  ('management', 'Management Queue', 'Incoming key word “Derek for review” or “Leslie for review” or emails sent to management@urbanmop.ca (an alias under info@urbanmop.ca) route to management team', false, 7),
  ('hr', 'HR Queue', 'hr@urbanmop.ca, careers@urbanmop.ca and the hiring line', true, 8),
  ('payroll', 'Payroll Queue', 'Anything related to payroll inquiries', true, 9),
  ('jose', 'Jose Queue', 'Email sent to jose@urbanmop.ca', false, 10),
  ('google-reviews', 'Google Reviews', 'Ratings Email IT WAS GREAT will go into this queue', false, 11),
  ('admin', 'Admin', 'This is a dead end Admin queue to route conversations out of the Management or Ops box.', false, 12),
  ('fallback', 'Default Queue', 'A Queue for all incoming conversations that don’t match any rules', false, 13);

CREATE TEMP TABLE kustomer_rules (position int, name text, enabled boolean, conditions jsonb, action jsonb, replaces text) ON COMMIT DROP;
INSERT INTO kustomer_rules VALUES
  (10, 'System notices: mark done', true, '{"any":[{"from_contains":["notifications@kustomerapp.com","notify@ringcentral.com","feedback@slack.com","team@bark.com","noreply@ziprecruiter.com","noreply@facebookmail.com","news@team.semrush.com","localservices-noreply"]},{"to":["no-reply@urbanmop.ca"]},{"subject_contains":["New booking request by"],"text_excludes":["Booking inserted into Launch 27?: N"]}]}'::jsonb, '{"mark_done":true,"disposition":{"audience":"system","reason":"System notice","outcome":"No action needed"}}'::jsonb, 'Auto Close business rules, Auto Close Part 2, NoReply'),
  (20, 'Bank verification codes: keep out of shared queues', true, '{"text_contains":["RBCPayEdge Authentication Code","verification code for RBC","donotreply@rbcpayedge.com"]}'::jsonb, '{"queue":"payroll","mark_done":true,"redact":true,"disposition":{"audience":"system","reason":"Verification code","outcome":"Redacted"}}'::jsonb, 'RCB PayEdge Redirect, Auto assign to Payroll'),
  (30, 'Stripe disputes to Management', true, '{"from_contains":["notifications@stripe.com"],"text_contains":["is being disputed"]}'::jsonb, '{"queue":"management","priority":5}'::jsonb, 'Dispute from Stripe to management'),
  (40, 'Escalations to Management', true, '{"any":[{"to":["management@urbanmop.ca"]},{"text_contains":["Derek for review","Leslie for review"]}]}'::jsonb, '{"queue":"management","priority":4}'::jsonb, 'Management Queue'),
  (50, 'Sales Overflow(Cart Abandonment) Rule', true, '{"subject_contains":["Cart Abandonment","Cart Abandoned"]}'::jsonb, '{"queue":"sales-overflow","sla":"cart"}'::jsonb, 'Sales Overflow(Cart Abandonment) Rule'),
  (60, 'Keep in Sales Queue', true, '{"lead_stage":["Attempt #1","Attempt #2","Attempt #3","Contacted Highly Interested","Contacted Undecided","Non-Region","Not Interested-Other","Not Interested-Price","Not Interested-Timing"]}'::jsonb, '{"queue":"sales","sla":"standard"}'::jsonb, 'Keep in Sales Queue'),
  (70, 'Sales Queue Rule', true, '{"any":[{"subject_contains":["submitted an inquiry","New booking request by","Quote Lead","New Booking by Customer","Boxing Week","Boxing Day","Payment received: Invoice #","New Lead from Bark","Family Day Promo","Black Friday","Easter Promo","Prepaid booking cancellation by","Canada Day Promo","is interested in Carpet Cleaning services from UrbanMop"]},{"channel":["chat"]},{"text_contains":["quote","new request","Booking inserted into Launch 27?: No","UrbanMop Sales"]},{"to":["sales@urbanmop.ca"]}]}'::jsonb, '{"queue":"sales","sla":"quote","priority":4}'::jsonb, 'Sales Queue Rule'),
  (80, 'Facebook or Instagram to Sales Queue', true, '{"subject_contains":["New Facebook Lead","Lead Reactivation for Move In Move Out"]}'::jsonb, '{"queue":"sales","sla":"quote","priority":4}'::jsonb, 'Facebook or Instagram to Sales Queue'),
  (90, '1-3 Star Google Review to Jose', false, '{"subject_contains":["1-3 Star Google Review for"]}'::jsonb, '{"queue":"jose"}'::jsonb, '1-3 Star Google Review to Jose'),
  (100, 'HR email', true, '{"to":["hr@urbanmop.ca"]}'::jsonb, '{"queue":"hr","sla":"hiring"}'::jsonb, 'HR email'),
  (110, 'Billing & Financial Operations Queue', true, '{"any":[{"to":["billing@urbanmop.ca"]},{"subject_contains":["INTERAC e-Transfer:","Biller Report For Biller Code","Invoice - Reminder: Your payment to UrbanMop Inc. is due","Payment Submitted And In-Progress","Payment Complete - OTTAWA WEST COMMUNITY SUPPORT SERVICE","RBC PayEdge","RBC: Your verification code for RBCPayEdge"]},{"text_contains":["You will find in the attached .pdf document the preauthorized payment transactions report that will be processed shortly.","RBC PayEdge","RBC: Your verification code for RBCPayEdge"]},{"from_contains":["+18449282412"]}]}'::jsonb, '{"queue":"billing","sla":"standard"}'::jsonb, 'Billing & Financial Operations Queue'),
  (120, 'Financial Operations Rule', true, '{"any":[{"subject_contains":["Warning: The credit cards for","IMPORTANT: Credit Card validation failed for booking","bookings that need to be charged"]},{"text_contains":["These failures could be due to card expiration, insufficient funds, card number change"]}]}'::jsonb, '{"queue":"financial-operations","sla":"standard"}'::jsonb, 'Financial Operations Rule'),
  (130, 'Admin Queue rule', true, '{"text_contains":["upcoming schedule","changes to availability for team"],"subject_contains":["Changes to availability for team","upcoming schedule"]}'::jsonb, '{"queue":"admin"}'::jsonb, 'Admin Queue rule'),
  (140, 'Operations Queue Rule', true, '{"channel":["email"],"to":["info@urbanmop.ca"]}'::jsonb, '{"queue":"operations","sla":"standard"}'::jsonb, 'Operations Queue Rule'),
  (150, 'Billing Routing', false, '{"subject_contains":["Biller Report For Biller Code","Invoice - Reminder: Your payment to UrbanMop Inc. is due"]}'::jsonb, '{"queue":"billing","sla":"standard"}'::jsonb, 'Billing Routing'),
  (160, 'HR Queue Rule', true, '{"any":[{"from_contains":["pandadoc"]},{"to":["hr@urbanmop.ca","careers@urbanmop.ca","docs@email.pandadoc.net","+16136918368","docs@email.pandadocs.net"]},{"subject_contains":["myBackCheck.com Notification","Final Touchpoint (15 minutes)"]}]}'::jsonb, '{"queue":"hr","sla":"hiring"}'::jsonb, 'HR Queue Rule'),
  (170, 'Google Reviews Rule', true, '{"any":[{"text_contains":["it was great"]},{"subject_contains":["Subject: Ratings email"]}]}'::jsonb, '{"queue":"google-reviews"}'::jsonb, 'Google Reviews Rule'),
  (180, 'Jose Queue', true, '{"to":["jose@urbanmop.ca"]}'::jsonb, '{"queue":"jose"}'::jsonb, 'Jose Queue'),
  (190, 'Payroll Queue Rule', true, '{"any":[{"to":["payroll@urbanmop.ca"]},{"text_contains":["payroll"]}]}'::jsonb, '{"queue":"payroll","sla":"hiring"}'::jsonb, 'Payroll Queue Rule'),
  (200, 'Operations Queue (Cleaner Enroute/Check In Delay) Rule', true, '{"text_contains":["Cleaner has not notified of enroute or check in time through the app, 15min remain before the end of the booking arrival window"]}'::jsonb, '{"queue":"operations"}'::jsonb, 'Operations Queue (Cleaner Enroute/Check In Delay) Rule'),
  (210, 'Action from CEL Report route to Operations', true, '{"text_contains":["Action from CEL Visit Report"]}'::jsonb, '{"queue":"operations"}'::jsonb, 'Action from CEL Report route to Operations'),
  (220, 'Route to Customer Success', true, '{"to":["customersuccess@urbanmop.ca"]}'::jsonb, '{"queue":"customer-success","sla":"standard"}'::jsonb, 'Route to Customer Success'),
  (230, 'Accounts Receivables Rule', false, '{"subject_contains":["Biller Report For Biller Code"]}'::jsonb, '{"queue":"accounts-receivables","sla":"standard"}'::jsonb, 'Accounts Receivables Rule'),
  (240, 'Promo ticket email to sales queue', false, '{"from_contains":["accountservices@mailchimp.com"]}'::jsonb, '{"queue":"sales"}'::jsonb, 'Promo ticket email to sales queue'),
  (250, 'Cleaners to Operations', true, '{"contact_role":["cleaner"]}'::jsonb, '{"queue":"operations","sla":"cleaner","priority":4}'::jsonb, 'Cleaner business rule, Cleaner SMS SLA'),
  (260, 'Rating email (ok / not good) to Customer Success', true, '{"text_contains":["it was ok","it wasn''t good","it wasnt good"]}'::jsonb, '{"queue":"customer-success","sla":"standard"}'::jsonb, 'Rating email (ok / not good)'),
  (270, 'Hiring email to HR', true, '{"to":["hiring@urbanmop.ca"]}'::jsonb, '{"queue":"hr","sla":"hiring"}'::jsonb, 'Route SMS to Hiring Team, Route to Hiring Team'),
  (280, 'Ottawa SMS to Operations', true, '{"channel":["sms"],"to":["+16136919880"]}'::jsonb, '{"queue":"operations","sla":"standard"}'::jsonb, 'Route SMS to Operations Team'),
  (290, 'Calls to Operations', true, '{"channel":["voice"]}'::jsonb, '{"queue":"operations"}'::jsonb, 'RingCentral Policy'),
  (300, 'Operations - Chat Rule', true, '{"channel":["chat"]}'::jsonb, '{"queue":"operations"}'::jsonb, 'Operations - Chat Rule');

CREATE TEMP TABLE kustomer_teams (name text, description text, position int, queues text[]) ON COMMIT DROP;
INSERT INTO kustomer_teams VALUES
  ('(8AM-6PM)Operations Team', 'Daytime operations', 0, ARRAY['fallback', 'operations']::text[]),
  ('(After 6PM & Weekend)Operations Team', 'Evenings and weekends: operations and sales', 1, ARRAY['fallback', 'operations', 'sales']::text[]),
  ('Sales Team', 'Quotes, new inquiries, lead follow-up', 2, ARRAY['sales']::text[]),
  ('Sales Squad', 'Quotes, new inquiries, lead follow-up', 3, ARRAY['sales']::text[]),
  ('Sales Overflow', 'Cart abandonment', 4, ARRAY['sales-overflow']::text[]),
  ('Sales Master', 'Sales and cart abandonment', 5, ARRAY['sales', 'sales-overflow']::text[]),
  ('Customer Success', 'Retention and customer success', 6, ARRAY['customer-success']::text[]),
  ('Customer Success & Sales Queue', 'Customer success, sales and cart abandonment', 7, ARRAY['customer-success', 'sales', 'sales-overflow']::text[]),
  ('Billing & Financial Operations', 'Daily charges, failed payments, billing and invoices', 8, ARRAY['financial-operations', 'billing']::text[]),
  ('Financial Operations & Billing Team', 'Billing and invoices', 9, ARRAY['billing']::text[]),
  ('Payroll Team', 'Payroll inquiries', 10, ARRAY['payroll']::text[]),
  ('HR Team', 'HR, careers and hiring', 11, ARRAY['hr']::text[]),
  ('Management Team', 'Escalations and disputes', 12, ARRAY['management']::text[]),
  ('Jose Queue', 'Jose''s email', 13, ARRAY['jose']::text[]),
  ('Admin', 'Dead-end queue for conversations moved out of Management or Operations', 14, ARRAY['admin']::text[]),
  ('Email Team', 'No queues in Kustomer', 15, ARRAY[]::text[]),
  ('Voice Team', 'No queues in Kustomer', 16, ARRAY[]::text[]),
  ('Scheduling Team', 'No queues in Kustomer', 17, ARRAY[]::text[]);

-- The five teams the old seed made, and the team(s) working the same queues now.
CREATE TEMP TABLE kustomer_team_carry (old_name text, new_name text) ON COMMIT DROP;
INSERT INTO kustomer_team_carry VALUES
  ('Customer care', '(8AM-6PM)Operations Team'),
  ('Customer care', 'Customer Success'),
  ('Sales', 'Sales Team'),
  ('Finance', 'Billing & Financial Operations'),
  ('Finance', 'Payroll Team'),
  ('People', 'HR Team'),
  ('Management', 'Management Team');

-- Change history first, while the old rules, teams and Hiring queue are still there.
INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'rules.replaced', 'routing_rules', 'all', jsonb_build_object(
  'source', 'Kustomer routing export of Nov 25, 2026 (migration 0033)',
  'count', (SELECT count(*) FROM kustomer_rules),
  'added', COALESCE((SELECT jsonb_agg(k.name ORDER BY k.position) FROM kustomer_rules k WHERE k.name NOT IN (SELECT name FROM routing_rules)), '[]'::jsonb),
  'changed', COALESCE((SELECT jsonb_agg(k.name ORDER BY k.position) FROM kustomer_rules k JOIN routing_rules r ON r.name = k.name
                       WHERE (r.enabled, r.conditions, r.action) IS DISTINCT FROM (k.enabled, k.conditions, k.action)), '[]'::jsonb),
  'removed', COALESCE((SELECT jsonb_agg(r.name ORDER BY r.position) FROM routing_rules r WHERE r.name NOT IN (SELECT name FROM kustomer_rules)), '[]'::jsonb),
  'before', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', r.name, 'enabled', r.enabled, 'conditions', r.conditions, 'action', r.action, 'replaces', r.replaces) ORDER BY r.position)
                      FROM routing_rules r), '[]'::jsonb))
WHERE (SELECT yes FROM kustomer_seeded);

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'teams.replaced', 'teams', 'all', jsonb_build_object(
  'source', 'Kustomer routing export of Nov 25, 2026 (migration 0033)',
  'count', (SELECT count(*) FROM kustomer_teams),
  'removed', COALESCE((SELECT jsonb_agg(t.name ORDER BY t.position) FROM teams t WHERE t.name IN (SELECT old_name FROM kustomer_team_carry)), '[]'::jsonb),
  'before', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'name', t.name, 'description', t.description, 'lead_user_id', t.lead_user_id,
      'member_ids', COALESCE((SELECT jsonb_agg(m.user_id ORDER BY m.user_id) FROM team_members m WHERE m.team_id = t.id), '[]'::jsonb),
      'queues', COALESCE((SELECT jsonb_agg(q.slug ORDER BY q.position) FROM queue_teams qt JOIN queues q ON q.id = qt.queue_id WHERE qt.team_id = t.id), '[]'::jsonb)
    ) ORDER BY t.position, t.name) FROM teams t), '[]'::jsonb))
WHERE (SELECT yes FROM kustomer_seeded);

INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'queue.merged', 'queue', h.id::text, jsonb_build_object('source', 'Kustomer routing export of Nov 25, 2026 (migration 0033)', 'name', h.name, 'into', 'HR Queue',
  'conversations', (SELECT count(*) FROM conversations c WHERE c.queue_id = h.id))
FROM queues h WHERE h.slug = 'hiring' AND EXISTS (SELECT 1 FROM queues WHERE slug = 'hr');

-- 1. Queues. Restricted (private) flags of existing queues are left as they are.
UPDATE queues SET position = position + 100 WHERE (SELECT yes FROM kustomer_seeded) AND slug NOT IN (SELECT slug FROM kustomer_queues);
INSERT INTO queues (slug, name, description, restricted, position)
SELECT slug, name, description, restricted, position FROM kustomer_queues WHERE (SELECT yes FROM kustomer_seeded)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, position = EXCLUDED.position;

UPDATE conversations SET queue_id = (SELECT id FROM queues WHERE slug = 'hr')
WHERE queue_id = (SELECT id FROM queues WHERE slug = 'hiring') AND EXISTS (SELECT 1 FROM queues WHERE slug = 'hr');
UPDATE queues SET overflow_queue_id = (SELECT id FROM queues WHERE slug = 'hr')
WHERE overflow_queue_id = (SELECT id FROM queues WHERE slug = 'hiring') AND EXISTS (SELECT 1 FROM queues WHERE slug = 'hr');
INSERT INTO queue_members (queue_id, user_id)
SELECT (SELECT id FROM queues WHERE slug = 'hr'), user_id FROM queue_members
WHERE queue_id = (SELECT id FROM queues WHERE slug = 'hiring') AND EXISTS (SELECT 1 FROM queues WHERE slug = 'hr')
ON CONFLICT DO NOTHING;
DELETE FROM queues WHERE slug = 'hiring' AND EXISTS (SELECT 1 FROM queues WHERE slug = 'hr');

-- 2. Routing rules.
DELETE FROM routing_rules WHERE (SELECT yes FROM kustomer_seeded);
INSERT INTO routing_rules (position, name, enabled, conditions, action, replaces)
SELECT position, name, enabled, conditions, action, replaces FROM kustomer_rules WHERE (SELECT yes FROM kustomer_seeded) ORDER BY position;

-- 3. Teams.
UPDATE teams SET position = position + 100
WHERE (SELECT yes FROM kustomer_seeded) AND name NOT IN (SELECT name FROM kustomer_teams) AND name NOT IN (SELECT old_name FROM kustomer_team_carry);
INSERT INTO teams (name, description, position)
SELECT name, description, position FROM kustomer_teams WHERE (SELECT yes FROM kustomer_seeded)
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, position = EXCLUDED.position;
DELETE FROM queue_teams WHERE team_id IN (SELECT t.id FROM teams t JOIN kustomer_teams k ON k.name = t.name);
INSERT INTO queue_teams (queue_id, team_id)
SELECT q.id, t.id FROM kustomer_teams k
  JOIN teams t ON t.name = k.name
  CROSS JOIN LATERAL unnest(k.queues) AS s(slug)
  JOIN queues q ON q.slug = s.slug
ON CONFLICT DO NOTHING;

INSERT INTO team_members (team_id, user_id)
SELECT nt.id, m.user_id FROM kustomer_team_carry c
  JOIN teams ot ON ot.name = c.old_name
  JOIN team_members m ON m.team_id = ot.id
  JOIN teams nt ON nt.name = c.new_name
ON CONFLICT DO NOTHING;
UPDATE teams nt SET lead_user_id = ot.lead_user_id
FROM kustomer_team_carry c JOIN teams ot ON ot.name = c.old_name
WHERE nt.name = c.new_name AND nt.lead_user_id IS NULL AND ot.lead_user_id IS NOT NULL;
DELETE FROM teams WHERE name IN (SELECT old_name FROM kustomer_team_carry);

-- 4. Agents, named as a first sign-in would name them (they can change it under their
-- profile). Only where someone has signed in already: on an empty database the first
-- person to sign in becomes admin, and these rows would take that from them.
WITH added AS (
  INSERT INTO users (email, name, role, status_id, status_since)
  SELECT v.email, v.name, 'agent', (SELECT id FROM agent_statuses WHERE kind = 'offline' ORDER BY position LIMIT 1), now()
  FROM (VALUES ('mabutecarmelad@gmail.com', 'Mabutecarmelad'), ('khaje91aquino@gmail.com', 'Khaje91aquino'), ('simon@urbanmop.ca', 'Simon')) AS v(email, name)
  WHERE EXISTS (SELECT 1 FROM users)
  ON CONFLICT (email) DO NOTHING
  RETURNING id, email
)
INSERT INTO audit_log (action, object_type, object_id, detail)
SELECT 'user.added', 'user', id::text, jsonb_build_object('email', email, 'role', 'agent', 'source', 'migration 0033') FROM added;
