-- intafaced:destructive — proposal ids change from a random uuid to the business key gov:proposal:<space>:<author>:<n>. No amount or rate is rewritten. The uuid default is dropped on purpose.
-- MC-token-01. The proposal id is gov:proposal:<space>:<author>:<n>.
-- A client uuid is not that id, and the column must not keep a random default.
-- Votes address the same id. This rewrites no amount and no rate.

ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_proposal_id_fkey";

ALTER TABLE "token"."proposals" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "token"."proposals" ALTER COLUMN "id" TYPE text USING "id"::text;

ALTER TABLE "token"."governance_votes" ALTER COLUMN "proposal_id" TYPE text USING "proposal_id"::text;

ALTER TABLE "token"."governance_votes"
  ADD CONSTRAINT "governance_votes_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "token"."proposals" ("id");
