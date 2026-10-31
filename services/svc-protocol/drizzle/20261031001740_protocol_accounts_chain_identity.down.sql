-- intafaced:destructive — reversal of 20261031001740_protocol_accounts_chain_identity.sql
ALTER TABLE "protocol"."smart_accounts" DROP COLUMN IF EXISTS "deployed_genesis_hash";
