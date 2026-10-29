-- intafaced:destructive — reversal of 20261029145500_governance_voting_types.sql. Drops the voting-power snapshots, choice lists and ballots. A stored ballot without a basic choice makes the NOT NULL fail rather than deleting the vote.
-- Reverse of 20261029145500. No amount or rate is rewritten.
-- Postgres cannot remove an enum value safely; 'closed_ranked' stays in the enum, and its rows go back to 'closed' so the older code reads them.

UPDATE "token"."proposals" SET "status" = 'closed' WHERE "status" = 'closed_ranked';

ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_choice_or_ballot_check";
ALTER TABLE "token"."governance_votes" ALTER COLUMN "choice" SET NOT NULL;
ALTER TABLE "token"."governance_votes" DROP COLUMN IF EXISTS "ballot";

DROP TABLE IF EXISTS "token"."governance_snapshots";

ALTER TABLE "token"."proposals" DROP CONSTRAINT IF EXISTS "proposals_snapshot_seal_check";
ALTER TABLE "token"."proposals" DROP CONSTRAINT IF EXISTS "proposals_voting_type_check";
ALTER TABLE "token"."proposals"
  DROP COLUMN IF EXISTS "ranking",
  DROP COLUMN IF EXISTS "snapshot_hash",
  DROP COLUMN IF EXISTS "snapshot_total",
  DROP COLUMN IF EXISTS "snapshot_count",
  DROP COLUMN IF EXISTS "choices",
  DROP COLUMN IF EXISTS "voting_type";
