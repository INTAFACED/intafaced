-- svc-support · phishing reports (I-signin-sessions-27)
-- Reversal: 0014_ticket_phishing_report.down.sql
--
-- NOT tagged `intafaced:destructive`: it widens tickets_category_ck under the
-- same name and adds one nullable column. It drops no table, no column, and no
-- row.
--
-- A phishing ticket carries the pasted headers of the reported message in
-- message_headers. Any other category stores none, and the text is bounded the
-- same way as body (10,000 characters, the contracts bound).

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_category_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_category_ck"
  CHECK ("category" IN ('account', 'trading', 'deposit_withdraw', 'phishing', 'other'));

ALTER TABLE "support"."tickets" ADD COLUMN IF NOT EXISTS "message_headers" text;

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_message_headers_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_message_headers_ck"
  CHECK (
    "message_headers" IS NULL
    OR ("category" = 'phishing' AND char_length("message_headers") BETWEEN 1 AND 10000)
  );
