-- Operator revoke of one customer API key (DV-keys-04, ENGINE KS-11). One row per key: the first operator revoke writes
-- the actor and the reason; a repeat is a no-op and returns this row. No secret, hash or prefix is stored here.
-- Reversal: 0063_api_key_operator_revocations.down.sql

CREATE TABLE IF NOT EXISTS "identity"."api_key_operator_revocations" (
  "key_id" uuid PRIMARY KEY REFERENCES "identity"."api_keys" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL,
  "reason" text NOT NULL CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500),
  "client_request_id" text NOT NULL CHECK (char_length("client_request_id") BETWEEN 1 AND 128),
  "revoked_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "api_key_operator_revocations_user_idx"
  ON "identity"."api_key_operator_revocations" ("user_id", "revoked_at" DESC);
