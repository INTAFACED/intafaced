-- Reorg reversal for customer crypto deposits (W-deposit-06). A credited deposit remembers the block it was read from; when the
-- chain reports the transfer in a different block, or no longer reports it, the ledger credit is reversed once under the business
-- key `deposit.reverse:<network>:<tx_hash>:<output_index>`. `reversal_started_at` is written BEFORE the ledger call so a crash
-- between the two is retried with the same key. A reversal the customer's balance cannot cover (the funds were spent) is
-- `needs_review`, never a negative balance.
-- A reversed or reviewed row keeps its credit evidence, so the credited CHECK is loosened to: a credited row carries it, and the
-- two evidence columns are set together.
ALTER TABLE "pay"."custody_deposits" ADD COLUMN IF NOT EXISTS "block_height" text;
ALTER TABLE "pay"."custody_deposits" ADD COLUMN IF NOT EXISTS "block_hash" text;
ALTER TABLE "pay"."custody_deposits" ADD COLUMN IF NOT EXISTS "reversal_started_at" timestamptz;
ALTER TABLE "pay"."custody_deposits" ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;
ALTER TABLE "pay"."custody_deposits" ADD COLUMN IF NOT EXISTS "reversal_ledger_tx_id" text;

ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_block_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_block_ck" CHECK (
  ("block_height" IS NULL OR "block_height" ~ '^(0|[1-9][0-9]{0,29})$')
  AND ("block_hash" IS NULL OR "block_hash" ~ '^[A-Za-z0-9]{1,128}$')
);

ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset', 'chain_reorg', 'reversal_unfunded'));

ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_credited_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_credited_ck" CHECK (
  ("status" <> 'credited' OR ("credited_at" IS NOT NULL AND "ledger_tx_id" IS NOT NULL))
  AND (("credited_at" IS NULL) = ("ledger_tx_id" IS NULL))
  AND ("status" <> 'reversed' OR ("credited_at" IS NOT NULL AND "reversed_at" IS NOT NULL AND "reversal_ledger_tx_id" IS NOT NULL))
  AND ("reversal_started_at" IS NULL OR "credited_at" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "custody_deposits_reversal_idx"
  ON "pay"."custody_deposits" ("reversal_started_at") WHERE "status" = 'credited' AND "reversal_started_at" IS NOT NULL;
