-- intafaced:destructive — drops the API-key create audit. Keys themselves stay.
-- Forward migration: 0047_api_key_create_audit.sql

DROP TABLE IF EXISTS "identity"."api_key_create_audit";
