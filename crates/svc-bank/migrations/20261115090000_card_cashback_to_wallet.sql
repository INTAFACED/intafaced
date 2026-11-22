-- Cashback on a partner-held card capture (launch money model, OWNER 226 and 288; J-bank-13 #7). The card's money is the
-- card partner's, so cashback on it is never credited in our book: it is recorded once per authorisation with
-- `paid_by = 'wallet'`, with what was spent and the rank tier its rate came from, and handed to the rewards programme
-- (svc-campaigns), which owes it in USDC and pays it to the person's own wallet. `announced_at` is when the hand-over was
-- taken. A wallet row is never `settled` here and never names a ledger transaction: what was paid is the programme's
-- record. Rows from before (`paid_by = 'ledger'`) are the custodial path, unchanged. This table is a record, never a balance.
--
-- Reversal: 20261115090000_card_cashback_to_wallet.down.sql

ALTER TABLE "bank"."card_cashback" ADD COLUMN IF NOT EXISTS "paid_by" text NOT NULL DEFAULT 'ledger';
ALTER TABLE "bank"."card_cashback" ADD COLUMN IF NOT EXISTS "spend" numeric(38, 18);
ALTER TABLE "bank"."card_cashback" ADD COLUMN IF NOT EXISTS "tier" text;
ALTER TABLE "bank"."card_cashback" ADD COLUMN IF NOT EXISTS "announced_at" timestamptz;

ALTER TABLE "bank"."card_cashback" DROP CONSTRAINT IF EXISTS "card_cashback_paid_by_ck";
ALTER TABLE "bank"."card_cashback" ADD CONSTRAINT "card_cashback_paid_by_ck" CHECK (
  ("paid_by" = 'ledger' AND "spend" IS NULL AND "tier" IS NULL AND "announced_at" IS NULL)
  OR (
    "paid_by" = 'wallet' AND "status" = 'pending' AND "ledger_tx_id" IS NULL AND "spend" IS NOT NULL AND "spend" > 0
    AND "tier" IS NOT NULL
  )
);
