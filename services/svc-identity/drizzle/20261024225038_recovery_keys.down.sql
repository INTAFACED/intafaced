-- Reverses 20261024225038_recovery_keys.sql.
-- intafaced:destructive drops every account's recovery keys and heir; the owners would have to set them again.
DROP TABLE IF EXISTS "identity"."recovery_keys";
DROP TABLE IF EXISTS "identity"."recovery_plans";
