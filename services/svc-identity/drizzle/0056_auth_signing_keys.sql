-- Access-token signing keys with overlap (I-signin-sessions-31). Names only: the key
-- material stays in the host environment (IDENTITY_AUTH_KEYS), never in this table.
-- A removed id keeps its row so it can never sign again.
-- No rows = the single JWT_ACCESS_SECRET signs and verifies, as before rotation.
-- Reversal: 0056_auth_signing_keys.down.sql

CREATE TABLE IF NOT EXISTS "identity"."auth_signing_keys" (
  "key_id" text PRIMARY KEY CHECK ("key_id" ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  "state" text NOT NULL CHECK ("state" IN ('active', 'verify_only', 'removed')),
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  "retired_at" timestamptz,
  "actor_id" uuid NOT NULL,
  "approval_id" text NOT NULL
);

-- At most one key signs.
CREATE UNIQUE INDEX IF NOT EXISTS "auth_signing_keys_one_active_idx"
  ON "identity"."auth_signing_keys" ("state") WHERE "state" = 'active';
