-- svc-protocol · which chain a founding badge claim belongs to (chain identity)
-- Reversal: 20261031001739_protocol_badge_chain_identity.down.sql
--
-- A chain id alone does not name a chain: a TEST chain started again keeps its id and begins from a new genesis. Rows
-- that come from a chain read store the hash of block 0 beside the chain id, and the service treats a row from another
-- genesis as absent (`src/chain/identity.ts`). Null = written before this column; such a row is kept as it was.

-- A claim's mint (its tx hash, its slot) belongs to one chain. One badge per address per chain: the address index now
-- includes the genesis, so a claim on a chain that was started again is not blocked by one from the old chain.
ALTER TABLE "protocol"."founding_badge_claims" ADD COLUMN IF NOT EXISTS "genesis_hash" text;
DROP INDEX IF EXISTS "protocol"."founding_badge_claims_chain_address_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "founding_badge_claims_chain_address_idx"
  ON "protocol"."founding_badge_claims" ("chain_id", (COALESCE("genesis_hash", '')), "to_address");
