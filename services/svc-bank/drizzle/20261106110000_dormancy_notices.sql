-- RC-bank-01 (J-bank-16 #7): the dormancy fee. One row per notice the bank gave a quiet account
-- (`dormancy-notice:<user>:<asset>:<debitDate>`), written once, then settled once on its debit date: charged through
-- `feeCharge` (`fee:bank.dormancy:<user>:<asset>:<debitDate>`), or skipped when the balance is zero or below the fee, or
-- cancelled by activity after the notice. The fee is a RECORD of the amount noticed, never a balance.
CREATE TABLE IF NOT EXISTS "bank"."dormancy_notices" (
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "debit_date" text NOT NULL,
  "fee" numeric(38, 18) NOT NULL,
  "inactive_days" integer NOT NULL,
  "rule_version" text NOT NULL,
  "state" text NOT NULL DEFAULT 'noticed',
  "ledger_tx_id" text,
  "noticed_at" timestamptz NOT NULL,
  "settled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dormancy_notices_pk" PRIMARY KEY ("user_id", "asset_id", "debit_date"),
  CONSTRAINT "dormancy_notices_date_ck" CHECK ("debit_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT "dormancy_notices_fee_positive" CHECK ("fee" > 0),
  CONSTRAINT "dormancy_notices_state_ck" CHECK (
    ("state" = 'noticed' AND "settled_at" IS NULL AND "ledger_tx_id" IS NULL)
    OR ("state" IN ('cancelled', 'skipped_zero', 'skipped_insufficient') AND "settled_at" IS NOT NULL AND "ledger_tx_id" IS NULL)
    OR ("state" = 'charged' AND "settled_at" IS NOT NULL AND "ledger_tx_id" IS NOT NULL)
  )
);
-- At most one open notice per account and coin.
CREATE UNIQUE INDEX IF NOT EXISTS "dormancy_notices_open_idx" ON "bank"."dormancy_notices" ("user_id", "asset_id") WHERE "state" = 'noticed';
