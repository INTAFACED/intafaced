DROP TABLE IF EXISTS "bank"."deposit_addresses";
DROP TABLE IF EXISTS "bank"."customer_onramps";
DROP TABLE IF EXISTS "bank"."ramp_onramp_quotes";
DROP TABLE IF EXISTS "bank"."withdraw_destination_removals";
DROP INDEX IF EXISTS "bank"."user_withdraw_destinations_id_idx";
ALTER TABLE "bank"."user_withdraw_destinations" DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_label_ck";
ALTER TABLE "bank"."user_withdraw_destinations" DROP COLUMN IF EXISTS "label";
ALTER TABLE "bank"."user_withdraw_destinations" DROP COLUMN IF EXISTS "destination_id";
