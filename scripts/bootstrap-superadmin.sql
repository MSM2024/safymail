-- Run once against the remote D1 database after applying migrations.
-- Replace the values before execution. This is the first trusted administrator;
-- do not expose this SQL through a public endpoint.
INSERT INTO users (id, email, display_name, is_superadmin, status)
VALUES (
  'REPLACE_WITH_RANDOM_UUID',
  'admin@example.com',
  'Europe Mail Administrator',
  1,
  'active'
);
