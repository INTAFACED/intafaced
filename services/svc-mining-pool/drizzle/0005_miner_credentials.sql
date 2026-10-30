-- svc-mining-pool · one miner secret per account, for the miner door (J-more-catalogue-05 #5).
-- Reversal: 0005_miner_credentials.down.sql
-- The room issues the secret and shows it once; only its SHA-256 is kept here. Issuing again replaces it, so the old
-- secret stops working. The door refuses a connection whose secret does not match, before it touches any account state.

CREATE TABLE IF NOT EXISTS "mining_pool"."miner_credentials" (
  "account_id"  text PRIMARY KEY,
  "secret_hash" text NOT NULL CONSTRAINT "miner_credentials_hash_ck" CHECK ("secret_hash" ~ '^[0-9a-f]{64}$'),
  "issued_at"   timestamptz NOT NULL DEFAULT now()
);
