-- Self-service account freeze (I-account-lifecycle-08): the owner's own freeze of their account. It is not
-- users.status = 'frozen' (the staff freeze) and not the ledger freeze. One open freeze per user.
-- Reversal: 0061_account_self_freezes.down.sql

CREATE TABLE IF NOT EXISTS "identity"."account_self_freezes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'frozen' CHECK ("state" IN ('frozen', 'lifted')),
  "reason" text NOT NULL CHECK ("reason" IN ('compromise', 'temporary', 'personal')),
  "since" timestamptz NOT NULL DEFAULT now(),
  "lifted_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_self_freezes_one_open_uq"
  ON "identity"."account_self_freezes" ("user_id") WHERE "state" = 'frozen';
CREATE INDEX IF NOT EXISTS "account_self_freezes_user_idx" ON "identity"."account_self_freezes" ("user_id", "since" DESC);
