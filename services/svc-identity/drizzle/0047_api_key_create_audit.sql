-- KEYSTEPUP. Every API-key create is one row: who, which session, which key,
-- which scopes, which fresh factor. The secret is not stored.
-- Reversal: 0047_api_key_create_audit.down.sql. No balances.

CREATE TABLE IF NOT EXISTS "identity"."api_key_create_audit" (
  "audit_id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "session_id" uuid NOT NULL,
  "key_id" uuid NOT NULL,
  "scopes" text[] NOT NULL,
  "factor" text NOT NULL CHECK ("factor" IN ('totp', 'passkey', 'proof')),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "api_key_create_audit_user_idx"
  ON "identity"."api_key_create_audit" ("user_id", "created_at");
