-- svc-protocol · the embedded self-custody wallet (J-wallet-22, OWNER 237)
-- Reversal: 20261109084145_protocol_embedded_wallets.down.sql
--
-- One wallet per person, made by the owner's embedded-wallet provider with the person's passkey and no seed phrase. A
-- row is the wallet's address and the provider's id for it. There is no key column on purpose, and no passkey column:
-- the provider keeps the key and signs only after the person's passkey; INTAFACED holds no key material. No balance and
-- no money: the ledger posts nothing.

CREATE TABLE IF NOT EXISTS "protocol"."embedded_wallets" (
  -- The business key: wallet:embedded:<personId>. One wallet per person, ever; a replay writes nothing.
  "idempotency_key"    text PRIMARY KEY,
  -- The signed-in INTAFACED person the provider bound the wallet to.
  "user_id"            text NOT NULL,
  -- The provider adapter that made it (test, privy, turnkey).
  "provider"           text NOT NULL,
  -- The provider's own id for the wallet.
  "provider_wallet_id" text NOT NULL,
  -- Checksummed EVM address on the venue's network.
  "address"            text NOT NULL,
  -- True for a wallet the labelled TEST provider made (test stacks only).
  "test"               boolean NOT NULL,
  "created_at"         timestamptz NOT NULL,
  CONSTRAINT "embedded_wallets_key_ck" CHECK ("idempotency_key" = 'wallet:embedded:' || "user_id"),
  CONSTRAINT "embedded_wallets_address_shape_ck" CHECK ("address" ~ '^0x[0-9a-fA-F]{40}$'),
  CONSTRAINT "embedded_wallets_provider_ck" CHECK ("provider" IN ('test', 'privy', 'turnkey'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "embedded_wallets_user_idx" ON "protocol"."embedded_wallets" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "embedded_wallets_provider_wallet_idx"
  ON "protocol"."embedded_wallets" ("provider", "provider_wallet_id");
