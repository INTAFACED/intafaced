-- svc-protocol · signed intent orders with a Dutch-auction decay (D-swap-09, J-dex-protocol-03 #6 #7)
-- Reversal: 20261107090957_protocol_intent_orders.down.sql
--
-- One row per signed order: what the swapper's own wallet signed, word for word, and its signature, so the record proves
-- itself. The swapper's tokens never pass through the platform: SovereignReactor moves the input straight to the filler
-- and the output straight to the swapper. No balance and no ledger movement. State moves open -> filled | cancelled |
-- expired only from what the chain shows (the order's nonce spent, and its Filled or Cancelled event); amounts are token
-- base units (whole numbers, numeric(78,0): a uint256 always fits).

CREATE TABLE IF NOT EXISTS "protocol"."intent_orders" (
  -- The order's EIP-712 struct hash, lowercase hex: the business key, the same for a retry of the same signed order.
  "id"            text PRIMARY KEY,
  "chain_id"      integer NOT NULL,
  "reactor"       text NOT NULL,
  -- Checksummed EVM address of the swapper (the signer).
  "swapper"       text NOT NULL,
  "token_in"      text NOT NULL,
  "amount_in"     numeric(78, 0) NOT NULL,
  "token_out"     text NOT NULL,
  "start_out"     numeric(78, 0) NOT NULL,
  "end_out"       numeric(78, 0) NOT NULL,
  "decay_start"   bigint NOT NULL,
  "decay_end"     bigint NOT NULL,
  "deadline"      bigint NOT NULL,
  "nonce"         numeric(78, 0) NOT NULL,
  "signature"     text NOT NULL,
  -- The token's own EIP-2612 permit for the reactor, signed with the order when it is gasless: {value, deadline, signature}.
  "permit"        jsonb,
  "state"         text NOT NULL DEFAULT 'open' CHECK ("state" IN ('open', 'filled', 'cancelled', 'expired')),
  "amount_out"    numeric(78, 0),
  "filled_at"     bigint,
  "fill_tx"       text,
  -- When the order was handed to the filler feed; null until it was (a crash before announcing re-announces it).
  "announced_at"  timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("chain_id", "reactor", "swapper", "nonce")
);
CREATE INDEX IF NOT EXISTS "intent_orders_swapper_idx" ON "protocol"."intent_orders" ("chain_id", "swapper", "created_at" DESC);
