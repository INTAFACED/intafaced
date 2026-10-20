-- Reverses 0056_auth_signing_keys.sql: the table only names keys, so dropping it
-- returns signing to JWT_ACCESS_SECRET alone.
DROP TABLE IF EXISTS "identity"."auth_signing_keys";
