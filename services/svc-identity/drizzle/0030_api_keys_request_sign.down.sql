-- intafaced:destructive — drops replay nonces and the per-key signing secret.
-- Nonces are a 5-minute replay window, not a ledger. The signing secret cannot
-- be recovered after this reversal; a later opt-in issues a new one.
-- Forward migration: 0030_api_keys_request_sign.sql

DROP TABLE IF EXISTS "identity"."api_key_request_nonces";

ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "request_signing_secret";
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "require_non_empty_ip_allowlist";
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "require_signature";
