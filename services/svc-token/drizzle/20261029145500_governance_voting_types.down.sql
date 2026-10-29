-- intafaced:destructive — reversal of 20261029145500_governance_voting_types.sql. Drops the voting-power snapshots, choice lists and ballots. A stored ballot without a basic choice makes the NOT NULL fail rather than deleting the vote.
-- Reverse of 20261029145500. No amount or rate is rewritten.
-- Postgres cannot remove an enum value safely, so 'closed_ranked' stays in the enum. The older code has no status for a
-- ranked close and no verdict was taken, so a stored one refuses the reversal rather than being relabelled.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "token"."proposals" WHERE "status" = 'closed_ranked') THEN
    RAISE EXCEPTION 'token.proposals holds closed_ranked rows; the older code cannot read them';
  END IF;
END $$;

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
