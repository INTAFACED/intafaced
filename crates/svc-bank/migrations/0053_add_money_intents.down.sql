-- intafaced:destructive drops every add-money request record and the quotes' delivery estimates; no balance or ledger entry is touched
DROP TABLE IF EXISTS "bank"."add_money_requests";
ALTER TABLE "bank"."ramp_onramp_quotes" DROP CONSTRAINT IF EXISTS "ramp_onramp_quotes_estimate_ck";
ALTER TABLE "bank"."ramp_onramp_quotes" DROP COLUMN IF EXISTS "delivery_estimate";
DELETE FROM "bank"."customer_onramps" WHERE "method" = 'pay_by_bank';
DELETE FROM "bank"."ramp_onramp_quotes" q
 WHERE q."method" = 'pay_by_bank' AND NOT EXISTS (SELECT 1 FROM "bank"."customer_onramps" o WHERE o."quote_id" = q."id");
ALTER TABLE "bank"."customer_onramps" DROP CONSTRAINT IF EXISTS "customer_onramps_method_ck";
ALTER TABLE "bank"."customer_onramps" ADD CONSTRAINT "customer_onramps_method_ck"
  CHECK ("method" IN ('card', 'bank_transfer', 'wallet_pay'));
ALTER TABLE "bank"."ramp_onramp_quotes" DROP CONSTRAINT IF EXISTS "ramp_onramp_quotes_method_ck";
ALTER TABLE "bank"."ramp_onramp_quotes" ADD CONSTRAINT "ramp_onramp_quotes_method_ck"
  CHECK ("method" IN ('card', 'bank_transfer', 'wallet_pay'));
