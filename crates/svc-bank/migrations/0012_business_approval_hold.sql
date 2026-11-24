-- svc-bank — business dual-control LEDger hold (bank.business deepen)
--
-- Over-threshold propose reserves value in a purposed hold so "pending" is not
-- paper-only. hold_ledger_tx_id records the hold post; ledger_tx_id still names
-- the settle (approve) or stays null on reject/cancel after release.

ALTER TABLE "bank"."business_approvals"
  ADD COLUMN IF NOT EXISTS "hold_ledger_tx_id" text;
