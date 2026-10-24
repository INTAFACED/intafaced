-- Payment link share (M-adv-payments-core-19).
-- Reversal: 0132_pay_payment_link_share.down.sql
--
-- inactive_message is the merchant's words for a payer who still holds a
-- deactivated link. Null means no message was stored. confirmation_message
-- and confirmation_url are the after-payment behaviour. Both null means it
-- was not set. A redirect column, when set, is https. Nothing here is a price.

ALTER TABLE "pay"."payment_links" ADD COLUMN IF NOT EXISTS "inactive_message" text;
ALTER TABLE "pay"."payment_links" ADD COLUMN IF NOT EXISTS "confirmation_message" text;
ALTER TABLE "pay"."payment_links" ADD COLUMN IF NOT EXISTS "confirmation_url" text;

ALTER TABLE "pay"."payment_links" DROP CONSTRAINT IF EXISTS "payment_links_inactive_message_ck";
ALTER TABLE "pay"."payment_links"
  ADD CONSTRAINT "payment_links_inactive_message_ck"
  CHECK (
    "inactive_message" IS NULL
    OR (
      char_length(btrim("inactive_message")) > 0
      AND char_length("inactive_message") <= 500
    )
  );

ALTER TABLE "pay"."payment_links" DROP CONSTRAINT IF EXISTS "payment_links_confirmation_ck";
ALTER TABLE "pay"."payment_links"
  ADD CONSTRAINT "payment_links_confirmation_ck"
  CHECK (
    (
      "confirmation_message" IS NULL
      AND "confirmation_url" IS NULL
    )
    OR (
      "confirmation_url" IS NULL
      AND "confirmation_message" IS NOT NULL
      AND char_length(btrim("confirmation_message")) > 0
      AND char_length("confirmation_message") <= 500
    )
    OR (
      "confirmation_message" IS NULL
      AND "confirmation_url" IS NOT NULL
      AND char_length("confirmation_url") <= 2048
      AND "confirmation_url" ~ '^https://[^[:space:]/]+'
    )
  );
