-- intafaced:destructive — votes.choice drops NOT NULL so a non-basic ballot can be stored as data; a CHECK keeps exactly one of choice or ballot on every row. Nothing is deleted.
-- MC-token-03. Voting types, a choice list, and voting power fixed when a
-- proposal is created. Power is a stored measurement of the stake pots, sealed
-- on the proposal by count, total and hash. It is never a balance and nothing
-- here moves value. No amount or rate is rewritten.

DO $$ BEGIN
  ALTER TYPE "token"."proposal_status" ADD VALUE 'closed_ranked';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "token"."proposals"
  ADD COLUMN IF NOT EXISTS "voting_type" text NOT NULL DEFAULT 'basic',
  ADD COLUMN IF NOT EXISTS "choices" jsonb,
  ADD COLUMN IF NOT EXISTS "snapshot_count" integer,
  ADD COLUMN IF NOT EXISTS "snapshot_total" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "snapshot_hash" text,
  ADD COLUMN IF NOT EXISTS "ranking" jsonb;

ALTER TABLE "token"."proposals" DROP CONSTRAINT IF EXISTS "proposals_voting_type_check";
ALTER TABLE "token"."proposals"
  ADD CONSTRAINT "proposals_voting_type_check"
  CHECK ("voting_type" IN ('basic', 'single_choice', 'approval', 'weighted', 'quadratic', 'ranked_choice'));

-- A seal is all three or none. Rows from before this migration have none and
-- keep the cast-time read.
ALTER TABLE "token"."proposals" DROP CONSTRAINT IF EXISTS "proposals_snapshot_seal_check";
ALTER TABLE "token"."proposals"
  ADD CONSTRAINT "proposals_snapshot_seal_check"
  CHECK (
    ("snapshot_count" IS NULL AND "snapshot_total" IS NULL AND "snapshot_hash" IS NULL)
    OR ("snapshot_count" >= 0 AND "snapshot_total" >= 0 AND "snapshot_hash" IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS "token"."governance_snapshots" (
  "proposal_id" text NOT NULL REFERENCES "token"."proposals" ("id"),
  "user_id" text NOT NULL,
  "power" numeric(38, 18) NOT NULL CHECK ("power" > 0),
  "taken_at" timestamptz NOT NULL,
  PRIMARY KEY ("proposal_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "governance_snapshots_user_idx"
  ON "token"."governance_snapshots" ("user_id", "taken_at" DESC);

-- A non-basic ballot is stored as data, an abstain included (`{"kind":"abstain"}`); `choice` holds only a basic vote.
ALTER TABLE "token"."governance_votes" ADD COLUMN IF NOT EXISTS "ballot" jsonb;
ALTER TABLE "token"."governance_votes" ALTER COLUMN "choice" DROP NOT NULL;
ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_choice_or_ballot_check";
ALTER TABLE "token"."governance_votes"
  ADD CONSTRAINT "governance_votes_choice_or_ballot_check"
  CHECK (("choice" IS NULL) <> ("ballot" IS NULL));
