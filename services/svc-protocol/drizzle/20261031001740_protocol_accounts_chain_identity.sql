-- svc-protocol · which chain a smart account was seen deployed on (chain identity)
-- Reversal: 20261031001740_protocol_accounts_chain_identity.down.sql
--
-- A chain id alone does not name a chain: a TEST chain started again keeps its id and begins from a new genesis. Rows
-- that come from a chain read store the hash of block 0 beside the chain id, and the service treats a row from another
-- genesis as absent (`src/chain/identity.ts`). Null = written before this column; such a row is kept as it was.

-- `deployed` was read from the chain: it holds only on the chain it was seen on.
ALTER TABLE "protocol"."smart_accounts" ADD COLUMN IF NOT EXISTS "deployed_genesis_hash" text;
