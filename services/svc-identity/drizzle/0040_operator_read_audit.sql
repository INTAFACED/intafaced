-- Operator account search and session-list audits, plus the receipt for
-- identity.revoke_sessions so a replay returns the first result.
-- The query is stored only as a hash. No email, name, token, or address.
-- Reversal: 0040_operator_read_audit.down.sql

CREATE TABLE IF NOT EXISTS "identity"."operator_read_audit" (
  "audit_id" uuid PRIMARY KEY,
  "actor_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('account_search', 'session_list')),
  "query_hash" text NOT NULL CHECK (char_length("query_hash") = 64),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "operator_read_audit_actor_idx"
  ON "identity"."operator_read_audit" ("actor_id", "created_at");

CREATE TABLE IF NOT EXISTS "identity"."session_revoke_receipts" (
  "actor_id" uuid NOT NULL,
  "client_request_id" text NOT NULL CHECK (char_length("client_request_id") BETWEEN 1 AND 200),
  "fingerprint" text NOT NULL CHECK (char_length("fingerprint") = 64),
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("actor_id", "client_request_id")
);
