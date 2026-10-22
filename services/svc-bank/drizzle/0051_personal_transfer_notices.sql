-- The posted personal send is its own outbox for the "money sent / money received" notices (PP-send-request-18).
--
-- `posted_at` is written in the same UPDATE that marks the send posted, and `announced_at` stays empty until the bus
-- has taken `bank.personal_transfer.posted` for it. A send that posted and was never announced (the publish failed,
-- timed out, or the process stopped between the two) is found by the partial index and announced again by the bank's
-- recovery timer. Redelivery is safe: the event's business key is `pay.transfer_posted:<transferId>`.
--
-- Sends that posted before this migration predate the notices, so they are marked announced: nobody is told today
-- about a payment from last month.
--
-- Reversal: 0051_personal_transfer_notices.down.sql

ALTER TABLE "bank"."personal_transfers" ADD COLUMN IF NOT EXISTS "posted_at" timestamptz;
ALTER TABLE "bank"."personal_transfers" ADD COLUMN IF NOT EXISTS "announced_at" timestamptz;

UPDATE "bank"."personal_transfers"
   SET "posted_at" = COALESCE("posted_at", "created_at"),
       "announced_at" = COALESCE("announced_at", "created_at")
 WHERE "status" = 'posted';

-- svc-bank's two posting UPDATEs write `posted_at`; a posted row without one counts from when it was reserved.
CREATE INDEX IF NOT EXISTS "personal_transfers_unannounced_idx"
  ON "bank"."personal_transfers" ("created_at")
  WHERE "status" = 'posted' AND "announced_at" IS NULL;
