-- How a complaint case was tied to its Launch27 client, when the engine did it after the
-- fact (service.js, linkClients): through a contact's email or phone, or by full name.
-- Null for cases matched when they were first read (Launch27's own email or phone lookup).
ALTER TABLE complaint_cases ADD COLUMN IF NOT EXISTS client_match text;   -- contact | contact_name | name
