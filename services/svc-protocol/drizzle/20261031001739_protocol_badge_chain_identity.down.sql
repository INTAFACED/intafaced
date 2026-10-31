-- intafaced:destructive — reversal of 20261031001739_protocol_badge_chain_identity.sql
-- The address index goes back to one badge per address per chain id. If claims on two genesis hashes now share an
-- address, it cannot be rebuilt: delete the rows from the chain that is gone first.
DROP INDEX IF EXISTS "protocol"."founding_badge_claims_chain_address_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "founding_badge_claims_chain_address_idx"
  ON "protocol"."founding_badge_claims" ("chain_id", "to_address");
ALTER TABLE "protocol"."founding_badge_claims" DROP COLUMN IF EXISTS "genesis_hash";
