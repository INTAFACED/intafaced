-- Customer security lock (W-withdraw-09, wallet-withdraw-015): the owner's own switch that stops withdrawals and changes
-- to withdrawal addresses, the password and verification. Not users.status (the staff freeze), not account_self_freezes
-- and not the ledger freeze. One open lock per user. An unlock is a request: unlocks_at is fixed when it is asked for and
-- never moved earlier; the lock holds until then.
-- Reversal: 0072_account_security_locks.down.sql

CREATE TABLE IF NOT EXISTS "identity"."account_security_locks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'locked' CHECK ("state" IN ('locked', 'ended')),
  "set_by" text NOT NULL CHECK ("set_by" IN ('self', 'support')),
  "set_by_user_id" uuid NOT NULL,
  "locked_at" timestamptz NOT NULL DEFAULT now(),
  "unlock_requested_at" timestamptz,
  "unlocks_at" timestamptz,
  "ended_at" timestamptz,
  CHECK (("unlock_requested_at" IS NULL) = ("unlocks_at" IS NULL)),
  CHECK ("unlocks_at" IS NULL OR "unlocks_at" >= "unlock_requested_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_security_locks_one_open_uq"
  ON "identity"."account_security_locks" ("user_id") WHERE "state" = 'locked';
CREATE INDEX IF NOT EXISTS "account_security_locks_user_idx" ON "identity"."account_security_locks" ("user_id", "locked_at" DESC);
