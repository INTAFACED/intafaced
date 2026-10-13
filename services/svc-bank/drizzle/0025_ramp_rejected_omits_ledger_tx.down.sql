ALTER TABLE "bank"."ramp_offramps" DROP CONSTRAINT IF EXISTS "ramp_offramps_release_only_when_rejected_ck";
ALTER TABLE "bank"."ramp_offramps" DROP CONSTRAINT IF EXISTS "ramp_offramps_rejected_omits_ledger_tx_ck";
ALTER TABLE "bank"."ramp_onramps" DROP CONSTRAINT IF EXISTS "ramp_onramps_rejected_omits_ledger_tx_ck";
ALTER TABLE "bank"."ramp_offramps" DROP COLUMN IF EXISTS "release_ledger_tx_id";
