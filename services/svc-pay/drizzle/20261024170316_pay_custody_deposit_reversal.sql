-- W-deposit-06 (J-wallet-03 #5): a customer crypto deposit the chain took back. NO BALANCE LIVES HERE. A credited row is
-- reversed by ONE ledger `depositReverse`, keyed `deposit.reverse:crypto-native:<network>:<tx_hash>:<output_index>`:
-- `reversal_started_at` is written before the ledger is asked, and the flip to `reversed` stores the reversal's transaction id
-- and time. A reversed row keeps `credited_at` and `ledger_tx_id`, the credit it reverses. A reversal the balance cannot cover
-- is `needs_review` with reason `reversal_unfunded`, keeping its credit and posting nothing. A row never credited is closed
-- `reversed` (reason `chain_reorg`) with no transaction. While a reversal runs the row is `needs_review` (reason `chain_reorg`)
-- with `reversal_started_at` set, so no sweep or announcement treats it as credited.
-- `custody_deposit_reorgs` keeps every reported reorg by chain position, so a sighting that arrives after its reorg (a late
-- delivery) is put in review instead of credited.
-- Reversal: 20261024170316_pay_custody_deposit_reversal.down.sql

ALTER TABLE "pay"."custody_deposits"
  ADD COLUMN IF NOT EXISTS "reversal_started_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "reversal_ledger_tx_id" text,
  ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;

ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset', 'address_expired', 'chain_reorg',
   'reversal_unfunded'));

-- A credit is a credit time and its transaction together. A credited row has one; a reversed row or one whose reversal could
-- not be covered may keep the one it had; no other row ever has one.
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_credited_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_credited_ck" CHECK (
  ("credited_at" IS NULL) = ("ledger_tx_id" IS NULL)
  AND ("status" <> 'credited' OR "credited_at" IS NOT NULL)
  AND ("credited_at" IS NULL OR "status" IN ('credited', 'reversed', 'needs_review'))
);

-- A reversal is its time and its transaction together, only on a reversed row that had a credit to reverse.
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reversed_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reversed_ck" CHECK (
  ("reversed_at" IS NULL) = ("reversal_ledger_tx_id" IS NULL)
  AND ("reversed_at" IS NULL OR ("status" = 'reversed' AND "credited_at" IS NOT NULL))
  AND ("reversal_started_at" IS NULL OR "credited_at" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "pay"."custody_deposit_reorgs" (
  "network_id" text NOT NULL,
  "address" text NOT NULL,
  "tx_hash" text NOT NULL,
  "output_index" integer NOT NULL,
  "reported_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("network_id", "address", "tx_hash", "output_index"),
  CONSTRAINT "custody_deposit_reorgs_ck" CHECK (
    "output_index" >= 0 AND "address" = lower("address") AND "tx_hash" = lower("tx_hash") AND "network_id" ~ '^[A-Za-z0-9_-]{1,32}$'
  )
);
