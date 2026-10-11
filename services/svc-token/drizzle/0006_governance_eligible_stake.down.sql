ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_eligible_stake_ck";
ALTER TABLE "token"."governance_votes" DROP COLUMN IF EXISTS "eligible_stake";
