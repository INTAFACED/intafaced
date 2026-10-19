-- Account closure request. One open request per user. History stays.
-- Reversal: 0048_account_closures.down.sql. No balances. No deletes of users.

CREATE TABLE IF NOT EXISTS "identity"."account_closures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "status" text NOT NULL CHECK ("status" IN ('requested', 'cancelled', 'blocked', 'closed')),
  "requested_at" timestamptz NOT NULL,
  "effective_at" timestamptz NOT NULL,
  "finalized_at" timestamptz,
  "blockers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "client_request_id" text NOT NULL CHECK (char_length("client_request_id") BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_closures_client_idx"
  ON "identity"."account_closures" ("user_id", "client_request_id");

CREATE UNIQUE INDEX IF NOT EXISTS "account_closures_one_open_idx"
  ON "identity"."account_closures" ("user_id")
  WHERE "status" = 'requested';

CREATE INDEX IF NOT EXISTS "account_closures_due_idx"
  ON "identity"."account_closures" ("effective_at", "id")
  WHERE "status" = 'requested';
