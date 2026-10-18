-- Audit of API-key actions that needed a fresh second factor. The accepted
-- factor kind is recorded; no secret and no key material is stored.
-- Reversal: 0047_api_key_action_audit.down.sql.

CREATE TABLE IF NOT EXISTS "identity"."api_key_action_audit" (
  "audit_id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "session_id" uuid NOT NULL,
  "action" text NOT NULL,
  "key_id" uuid,
  "scopes" text[] NOT NULL DEFAULT '{}',
  "factor" text NOT NULL CHECK ("factor" IN ('totp', 'passkey', 'proof')),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "api_key_action_audit_user_idx"
  ON "identity"."api_key_action_audit" ("user_id", "created_at");
