-- Cash out for a person whose bank money the partner holds (OWNER 226; J-bank-03 adapted), and a payout the partner
-- cancels before paying it.
--
-- A partner-held request (`custodian` names the partner) never touches the ledger: it is ONE partner move of the amount
-- from the person's main balance into the partner's outbound-payments account under the order key
-- (`bank.cash-out:<id>`, `partner_move_id`). Paid only closes it. Failed or cancelled gives it back once
-- (`bank.cash-out-back:<id>`, `partner_back_move_id`); a return credits what came back once (`bank.cash-out-return:<id>`,
-- `partner_return_move_id`). So a partner-held row names no ledger transaction at all, and a ledger row names no
-- partner move: one request moves money in one book only.
--
-- `cancelled` is the partner's answer that it will not pay a payout it took: like `failed`, with its reason, and the
-- amount given back once. Every row the old rule allowed, this one allows.
--
-- Reversal: 20261109094705_cash_out_partner_held.down.sql

ALTER TABLE "bank"."cash_out_requests"
  DROP CONSTRAINT IF EXISTS "cash_out_requests_status_ck",
  ADD COLUMN IF NOT EXISTS "custodian" text,
  ADD COLUMN IF NOT EXISTS "partner_move_id" text,
  ADD COLUMN IF NOT EXISTS "partner_back_move_id" text,
  ADD COLUMN IF NOT EXISTS "partner_return_move_id" text,
  ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz,
  ADD CONSTRAINT "cash_out_requests_one_book_ck" CHECK (
    "custodian" IS NULL AND "partner_move_id" IS NULL AND "partner_back_move_id" IS NULL AND "partner_return_move_id" IS NULL
    OR "custodian" IS NOT NULL AND "hold_ledger_tx_id" IS NULL AND "settle_ledger_tx_id" IS NULL
       AND "reverse_ledger_tx_id" IS NULL AND "return_ledger_tx_id" IS NULL
  ),
  ADD CONSTRAINT "cash_out_requests_status_ck" CHECK (
    ("status" = 'refused' AND "refusal_code" IS NOT NULL AND "payout_rail" IS NULL AND "hold_ledger_tx_id" IS NULL
        AND "partner_move_id" IS NULL)
    OR ("status" = 'processing' AND "refusal_code" IS NULL AND "payout_rail" IS NOT NULL AND "settle_ledger_tx_id" IS NULL
        AND "reverse_ledger_tx_id" IS NULL AND "partner_back_move_id" IS NULL)
    OR ("status" = 'completed' AND "payout_rail" IS NOT NULL AND "completed_at" IS NOT NULL AND "returned_amount" IS NULL
        AND (("hold_ledger_tx_id" IS NOT NULL AND "settle_ledger_tx_id" IS NOT NULL) OR "partner_move_id" IS NOT NULL))
    OR ("status" = 'failed' AND "payout_rail" IS NOT NULL AND "failure_code" IS NOT NULL AND "settle_ledger_tx_id" IS NULL
        AND "failed_at" IS NOT NULL)
    OR ("status" = 'cancelled' AND "payout_rail" IS NOT NULL AND "failure_code" IS NOT NULL AND "settle_ledger_tx_id" IS NULL
        AND "cancelled_at" IS NOT NULL)
    OR ("status" = 'returned' AND "returned_amount" IS NOT NULL AND "failure_code" IS NOT NULL AND "returned_at" IS NOT NULL
        AND (("settle_ledger_tx_id" IS NOT NULL AND "return_ledger_tx_id" IS NOT NULL)
             OR ("partner_move_id" IS NOT NULL AND "partner_return_move_id" IS NOT NULL)))
  );

-- One partner move names one request.
CREATE UNIQUE INDEX IF NOT EXISTS "cash_out_requests_partner_move_idx"
  ON "bank"."cash_out_requests" ("partner_move_id") WHERE "partner_move_id" IS NOT NULL;
