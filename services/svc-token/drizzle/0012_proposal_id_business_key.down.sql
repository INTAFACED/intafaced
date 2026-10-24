-- intafaced:destructive — reversal of 0012_proposal_id_business_key.sql. A non-uuid id cannot be cast back, so the statement fails rather than deleting the row.
-- Reverse of 0012.
-- A proposal id that is not a uuid cannot be cast back. This refuses rather
-- than dropping the row. No amount and no rate is rewritten.

ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_proposal_id_fkey";

ALTER TABLE "token"."governance_votes" ALTER COLUMN "proposal_id" TYPE uuid USING "proposal_id"::uuid;

ALTER TABLE "token"."proposals" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;
ALTER TABLE "token"."proposals" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE "token"."governance_votes"
  ADD CONSTRAINT "governance_votes_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "token"."proposals" ("id");
