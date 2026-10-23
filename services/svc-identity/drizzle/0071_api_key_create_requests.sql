-- The developer room's key create (DV-keys-01, J-developer-03) is idempotent by the client's request id, a business
-- key. One row per (person, request id) names the key that request made and a hash of what it asked for, so a repeat
-- returns the same record without the secret and the same id asking for a different key refuses.
-- Reversal: 0071_api_key_create_requests.down.sql

CREATE TABLE IF NOT EXISTS "identity"."api_key_create_requests" (
  "user_id" uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL CHECK (length("request_id") BETWEEN 8 AND 200),
  "key_id" uuid NOT NULL REFERENCES "identity"."api_keys"("id") ON DELETE CASCADE,
  "fingerprint" text NOT NULL CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "request_id")
);

-- Name lookups on create compare without regard to case among a person's live keys.
CREATE INDEX IF NOT EXISTS "api_keys_user_lower_name_idx" ON "identity"."api_keys" ("user_id", lower("name")) WHERE "revoked" = false;
