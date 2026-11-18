-- One-time: make Derek an admin. His account was created as an agent at first sign-in, and
-- ADMIN_EMAILS can't be changed without Railway access. Runs once per database; a no-op
-- where he hasn't signed in yet (ADMIN_EMAILS or Support settings cover that case).
UPDATE users SET role = 'admin' WHERE lower(email) = 'derek@urbanmop.ca' AND role <> 'admin';
