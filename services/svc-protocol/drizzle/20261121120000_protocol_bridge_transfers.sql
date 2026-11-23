-- svc-protocol · bridge transfers (D-bridge-chain-03; J-dex-protocol-05 #6 #7)
-- Reversal: 20261121120000_protocol_bridge_transfers.down.sql
--
-- One row per burn-and-mint transfer a wallet starts, stored BEFORE the wallet is asked to burn, so a transfer whose
-- page or process stopped after that point is found again and resumed from the chains. The bridge is non-custodial:
-- the wallet signs the burn and the mint, this row holds no key and no balance, and nothing posts to the ledger.

CREATE TABLE IF NOT EXISTS "protocol"."bridge_transfers" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The business key the client sent; one transfer per wallet and key.
  "wallet"        text NOT NULL,
  "client_key"    text NOT NULL,
  -- keccak256 of the business key: the burn and the mint carry it, and each happens once per intent on chain.
  "intent_id"     text NOT NULL UNIQUE,
  "from_chain_id" integer NOT NULL,
  "to_chain_id"   integer NOT NULL,
  "token"         text NOT NULL,
  -- The amount in the token's smallest unit, as a decimal string: never a float.
  "amount_units"  numeric(78, 0) NOT NULL,
  "state"         text NOT NULL DEFAULT 'awaiting_burn',
  "burn_tx"       text,
  "attestation"   text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bridge_transfers_wallet_ck" CHECK ("wallet" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "bridge_transfers_intent_ck" CHECK ("intent_id" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "bridge_transfers_amount_ck" CHECK ("amount_units" > 0),
  CONSTRAINT "bridge_transfers_chains_ck" CHECK ("from_chain_id" <> "to_chain_id"),
  CONSTRAINT "bridge_transfers_state_ck" CHECK ("state" IN ('awaiting_burn', 'burn_submitted', 'mint_ready', 'minted')),
  -- Past the wait for the burn, the burn's hash is always known; a mint is offered only with its attestation.
  CONSTRAINT "bridge_transfers_burn_ck" CHECK ("state" = 'awaiting_burn' OR ("burn_tx" IS NOT NULL AND "burn_tx" ~ '^0x[0-9a-f]{64}$')),
  CONSTRAINT "bridge_transfers_attested_ck" CHECK ("state" <> 'mint_ready' OR "attestation" IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_transfers_key_idx" ON "protocol"."bridge_transfers" ("wallet", "client_key");
CREATE INDEX IF NOT EXISTS "bridge_transfers_wallet_idx" ON "protocol"."bridge_transfers" ("wallet", "created_at" DESC);
