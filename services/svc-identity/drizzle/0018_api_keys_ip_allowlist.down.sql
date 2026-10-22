-- Reverse 0018_api_keys_ip_allowlist.sql
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "ip_allowlist";
