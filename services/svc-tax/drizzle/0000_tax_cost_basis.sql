-- svc-tax · cost-basis choices (J-portfolio-04 steps 4 and 5)
-- Reversal: 0000_tax_cost_basis.down.sql
--
-- The customer's own choices for their profit and loss indicator: a matching method for the account ('*') or one coin,
-- one for a single UTC day, and which lot a sale used. Settings only: no balance, no amount, no ledger id. The lot book
-- reads the ledger and applies these when it is read.
--
-- Every statement is idempotent, so the file is re-runnable.

CREATE TABLE IF NOT EXISTS "tax"."method_choices" (
  "user_id"    uuid        NOT NULL,
  -- '*' is the whole account; otherwise the coin, e.g. BTC.
  "asset_id"   text        NOT NULL,
  "method"     text        NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "asset_id")
);

CREATE TABLE IF NOT EXISTS "tax"."method_days" (
  "user_id"    uuid        NOT NULL,
  "day"        date        NOT NULL,
  -- '*' is every coin on that day.
  "asset_id"   text        NOT NULL,
  "method"     text        NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "day", "asset_id")
);

CREATE TABLE IF NOT EXISTS "tax"."lot_picks" (
  "user_id"    uuid        NOT NULL,
  -- The ledger transaction of the sale, and the coin it sold.
  "sale_tx_id" text        NOT NULL,
  "asset_id"   text        NOT NULL,
  -- `lot:<acquireTxId>:<assetId>`, the lot book's repeatable id.
  "lot_id"     text        NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "sale_tx_id", "asset_id")
);

ALTER TABLE "tax"."method_choices" DROP CONSTRAINT IF EXISTS "method_choices_method_check";
ALTER TABLE "tax"."method_choices" ADD CONSTRAINT "method_choices_method_check" CHECK ("method" IN ('FIFO', 'LIFO', 'HIFO', 'AVERAGE'));
ALTER TABLE "tax"."method_days" DROP CONSTRAINT IF EXISTS "method_days_method_check";
ALTER TABLE "tax"."method_days" ADD CONSTRAINT "method_days_method_check" CHECK ("method" IN ('FIFO', 'LIFO', 'HIFO', 'AVERAGE'));
