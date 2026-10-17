-- svc-identity · per-key opt-in inbound request signature
-- Reversal: 0030_api_keys_request_sign.down.sql
--
-- require_signature defaults false: existing keys stay unsigned.
-- require_non_empty_ip_allowlist defaults false: an empty allowlist stays open
-- until the key opts in. request_signing_secret is the HMAC key, shown once
-- at opt-in, never listed. Ciphertext is enc:v1 (AES-256-GCM). Nonces are
-- kept until expires_at, which is the signed timestamp plus the acceptance
-- window, so a skewed client clock cannot drop a nonce while the signature
-- is still acceptable.

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
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("key_id", "nonce")
);

CREATE INDEX IF NOT EXISTS "api_key_request_nonces_expires_idx"
  ON "identity"."api_key_request_nonces" ("expires_at");
