-- Reverse 0014_ticket_phishing_report.sql
-- Lossy by nature: a phishing ticket becomes an `other` ticket so the older
-- category check holds, and its pasted headers are dropped with the column.

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_message_headers_ck";
UPDATE "support"."tickets" SET "category" = 'other' WHERE "category" = 'phishing';
ALTER TABLE "support"."tickets" DROP COLUMN IF EXISTS "message_headers";

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_category_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_category_ck"
  CHECK ("category" IN ('account', 'trading', 'deposit_withdraw', 'other'));
