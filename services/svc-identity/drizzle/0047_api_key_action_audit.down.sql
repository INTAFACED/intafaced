-- intafaced:destructive — drops the API-key action audit rows. Forward migration: 0047_api_key_action_audit.sql

DROP TABLE IF EXISTS "identity"."api_key_action_audit";
