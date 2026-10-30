-- intafaced:destructive — reversal of 20261029170000_governance_signed_votes.sql. Drops the stored signer, signature and signed message of each vote; the votes stay.
ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_signed_check";
ALTER TABLE "token"."governance_votes" DROP COLUMN IF EXISTS "signed_message", DROP COLUMN IF EXISTS "signature", DROP COLUMN IF EXISTS "signed_by";
