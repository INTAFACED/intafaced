-- intafaced:destructive — reversal of 20261031001738_protocol_listing_chain_identity.sql
ALTER TABLE "protocol"."listing_ownership_proofs" DROP COLUMN IF EXISTS "genesis_hash";
ALTER TABLE "protocol"."listing_challenges" DROP COLUMN IF EXISTS "genesis_hash";
