-- ramp_onramps and ramp_offramps are the crypto ledger half only.
--
-- 0004 created ramp_kind ('crypto', 'fiat') and defaulted kind to crypto.
-- Neither table checked the value, so a fiat onramp or offramp can be stored.
--
-- Both tables now refuse kind other than crypto. CHECK only. No UPDATE,
-- no DELETE, and no INSERT. If a stored row is already fiat, ADD CONSTRAINT
-- fails and that row stays.
--
-- Reversal: 0026_ramp_kind_crypto.down.sql

ALTER TABLE "bank"."ramp_onramps" DROP CONSTRAINT IF EXISTS "ramp_onramps_kind_crypto_ck";
ALTER TABLE "bank"."ramp_onramps" ADD CONSTRAINT "ramp_onramps_kind_crypto_ck"
  CHECK ("kind" = 'crypto');

ALTER TABLE "bank"."ramp_offramps" DROP CONSTRAINT IF EXISTS "ramp_offramps_kind_crypto_ck";
ALTER TABLE "bank"."ramp_offramps" ADD CONSTRAINT "ramp_offramps_kind_crypto_ck"
  CHECK ("kind" = 'crypto');
