-- intafaced:destructive — reversal of 0071_pay_merchant_names.sql
--
-- Drops the display and legal names on pay.merchants. They are only copies of what the
-- merchant typed at onboarding (the legal name also stays in settlement_prefs for
-- merchants onboarded by the portal), so no money or ledger data is touched; the
-- founder panel falls back to showing the merchant id alone.

ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_display_name_ck";
ALTER TABLE "pay"."merchants" DROP CONSTRAINT IF EXISTS "merchants_legal_name_ck";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "display_name";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "legal_name";
