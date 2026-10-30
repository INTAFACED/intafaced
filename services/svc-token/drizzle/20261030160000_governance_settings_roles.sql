-- J-more-catalogue-10 (MC-token-02): governance settings and roles, and a moderator's cancel.
-- The voting delay and period are owner values written by two founders. Blank means the author gives the time; a proposal
-- that gives neither time while the setting is blank refuses. Every change is a numbered row naming who asked and who approved.
CREATE TABLE IF NOT EXISTS "token"."governance_settings" (
  "id" smallint PRIMARY KEY CHECK ("id" = 1),
  "voting_delay_ms" bigint CHECK ("voting_delay_ms" >= 0),
  "voting_period_ms" bigint CHECK ("voting_period_ms" > 0),
  -- The number of changes written; 0 while nothing was ever set.
  "revision" integer NOT NULL CHECK ("revision" >= 0)
);

CREATE TABLE IF NOT EXISTS "token"."governance_settings_moves" (
  "ordinal" integer PRIMARY KEY CHECK ("ordinal" >= 1),
  "voting_delay_ms" bigint,
  "voting_period_ms" bigint,
  "actor_id" text NOT NULL,
  "approver_id" text NOT NULL CHECK ("approver_id" <> "actor_id"),
  "at" timestamptz NOT NULL DEFAULT now()
);

-- One governance role per account. A revoke is a move to no role; the row's revision counts every move.
CREATE TABLE IF NOT EXISTS "token"."governance_roles" (
  "user_id" text PRIMARY KEY,
  "role" text CHECK ("role" IN ('controller', 'admin', 'moderator', 'author')),
  "revision" integer NOT NULL CHECK ("revision" >= 1)
);

CREATE TABLE IF NOT EXISTS "token"."governance_role_moves" (
  "user_id" text NOT NULL,
  "ordinal" integer NOT NULL CHECK ("ordinal" >= 1),
  "from_role" text,
  "to_role" text,
  "actor_id" text NOT NULL,
  "approver_id" text NOT NULL CHECK ("approver_id" <> "actor_id"),
  "at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "ordinal"),
  -- A role is never asked for or approved by the account that receives it.
  CHECK ("actor_id" <> "user_id" AND "approver_id" <> "user_id")
);

-- A cancelled proposal keeps its votes; the cancel names who and why.
ALTER TABLE "token"."proposals" ADD COLUMN IF NOT EXISTS "cancel_reason" text;
ALTER TABLE "token"."proposals" ADD COLUMN IF NOT EXISTS "cancelled_by" text;
ALTER TABLE "token"."proposals" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz;
