-- One row each time a live founder's session is issued or refreshed.
-- The scopes column is the grant actually attached (empty when the config
-- grants nothing or the session is not MFA). config_hash is sha256 of the
-- config string, not the string itself.
-- Reversal: 0039_founder_session_scope_audit.down.sql

CREATE TABLE IF NOT EXISTS "identity"."founder_session_scope_audit" (
  "audit_id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "session_id" uuid NOT NULL,
  "scopes" text[] NOT NULL,
  "config_hash" text NOT NULL CHECK (char_length("config_hash") = 64),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "founder_session_scope_audit_user_idx"
  ON "identity"."founder_session_scope_audit" ("user_id", "created_at");
