-- svc-protocol · which chain a listing challenge and proof belong to (chain identity)
-- Reversal: 20261031001738_protocol_listing_chain_identity.down.sql
--
-- A chain id alone does not name a chain: a TEST chain started again keeps its id and begins from a new genesis. Rows
-- that come from a chain read store the hash of block 0 beside the chain id, and the service treats a row from another
-- genesis as absent (`src/chain/identity.ts`). Null = written before this column; such a row is kept as it was.

-- A challenge is good only on the chain it was issued for; a proof records the chain its owner was read on.
ALTER TABLE "protocol"."listing_challenges" ADD COLUMN IF NOT EXISTS "genesis_hash" text;
ALTER TABLE "protocol"."listing_ownership_proofs" ADD COLUMN IF NOT EXISTS "genesis_hash" text;
