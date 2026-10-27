-- W-deposit-09 (J-wallet-02 #7): a credited crypto deposit is announced once on the bus (`payDepositCreditPosted`), for the
-- customer's inbox. `credit_notified_at` records that svc-pay published it. A row credited and not yet recorded as announced
-- is announced again on the next pass, under the same business key, so a crash between the credit and the announcement
-- still reaches the customer. No money is held here and none moves: the ledger `deposit` post is the credit.
--
-- Credits from before this were shown in the customer's deposit records when they happened, so they are marked announced
-- here rather than told again days later.
-- Reversal: 20261024123500_pay_custody_deposit_credit_notice.down.sql

ALTER TABLE "pay"."custody_deposits" ADD COLUMN IF NOT EXISTS "credit_notified_at" timestamptz;

UPDATE "pay"."custody_deposits" SET "credit_notified_at" = "credited_at"
 WHERE "status" = 'credited' AND "credit_notified_at" IS NULL;

CREATE INDEX IF NOT EXISTS "custody_deposits_unannounced_idx"
  ON "pay"."custody_deposits" ("credited_at") WHERE "status" = 'credited' AND "credit_notified_at" IS NULL;
