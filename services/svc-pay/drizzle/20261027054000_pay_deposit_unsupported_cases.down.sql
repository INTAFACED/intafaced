-- intafaced:destructive — reversal of 20261027054000_pay_deposit_unsupported_cases.sql
--
-- Drops the owner's unsupported-case lists; customers see only the standard wrong-network line again.
ALTER TABLE "pay"."custody_deposit_settings" DROP CONSTRAINT IF EXISTS "custody_deposit_settings_unsupported_cases_ck";
ALTER TABLE "pay"."custody_deposit_settings" DROP COLUMN IF EXISTS "unsupported_cases";
DROP FUNCTION IF EXISTS "pay"."deposit_unsupported_cases_ok"(text[]);
