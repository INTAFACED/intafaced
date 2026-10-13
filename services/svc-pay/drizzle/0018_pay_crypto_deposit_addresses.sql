-- DURABLE DEPOSIT ADDRESS BOOK (Class M).
--
-- EvmLiveChain kept payment→address assignments in process maps. stableIndex
-- is deterministic, but the collision walk only sees assignments still in
-- that map. A new process could hand a payer's address to a different
-- payment, or a different address than the one already shown.
-- This table is the shared book. It does NOT hold balances — only which
-- payment and asset own a deposit address, and the HD slot that derived it.
-- hd_index is a derivation slot, not an amount.

CREATE TABLE IF NOT EXISTS "pay"."crypto_deposit_addresses" (
  "payment_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "address" text NOT NULL,
  "hd_index" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "crypto_deposit_addresses_pkey" PRIMARY KEY ("payment_id", "asset_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "crypto_deposit_addresses_address_idx"
  ON "pay"."crypto_deposit_addresses" ("address");
