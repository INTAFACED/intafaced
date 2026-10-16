-- svc-identity · per-key opt-in inbound request signature
-- Reversal: 0030_api_keys_request_sign.down.sql
--
-- require_signature defaults false: existing keys stay unsigned.
-- require_non_empty_ip_allowlist defaults false: an empty allowlist stays open
-- until the key opts in. request_signing_secret is the HMAC key, shown once
-- at opt-in, never listed. Nonces are remembered only for the 5-minute window.

ALTER TABLE "identity"."api_keys"
  ADD COLUMN IF NOT EXISTS "require_signature" boolean NOT NULL DEFAULT false;

ALTER TABLE "identity"."api_keys"
  ADD COLUMN IF NOT EXISTS "require_non_empty_ip_allowlist" boolean NOT NULL DEFAULT false;

ALTER TABLE "identity"."api_keys"
  ADD COLUMN IF NOT EXISTS "request_signing_secret" text;

CREATE TABLE IF NOT EXISTS "identity"."api_key_request_nonces" (
  "key_id" uuid NOT NULL REFERENCES "identity"."api_keys"("id") ON DELETE CASCADE,
  "nonce" text NOT NULL,
  "seen_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("key_id", "nonce")
);

CREATE INDEX IF NOT EXISTS "api_key_request_nonces_seen_idx"
  ON "identity"."api_key_request_nonces" ("seen_at");
