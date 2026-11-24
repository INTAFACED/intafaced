-- svc-bank — independent loan reserve funding log (B-02)
--
-- `reconcileReserve` must not define funded as reserve + outstanding (a
-- tautology). This table is the bank-side sum of every successful
-- `loanReserveFund` post, keyed by funding_id so retries stay one row.
-- Live reserve balance stays in the ledger; this is write-once history only.

CREATE TABLE IF NOT EXISTS "bank"."loan_reserve_fundings" (
  "funding_id" text PRIMARY KEY,
  "debt_asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "ledger_tx_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "loan_reserve_fundings_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX IF NOT EXISTS "loan_reserve_fundings_asset_settled_idx"
  ON "bank"."loan_reserve_fundings" ("debt_asset_id", "status");
