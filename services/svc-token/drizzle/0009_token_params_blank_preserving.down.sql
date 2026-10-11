-- Restore the pre-0009 contract only when every value is present. If a later
-- operator left a parameter blank, PostgreSQL refuses this reversal rather
-- than filling or deleting a value.

ALTER TABLE "token"."token_params" ALTER COLUMN "emission_curve" SET DEFAULT '{}'::jsonb;
ALTER TABLE "token"."token_params" ALTER COLUMN "fee_discount_schedule" SET DEFAULT '{}'::jsonb;
ALTER TABLE "token"."token_params" ALTER COLUMN "total_supply" SET NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "emission_curve" SET NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "halving_interval" SET NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "fee_discount_schedule" SET NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "buyback_bps" SET NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "burn_split_bps" SET NOT NULL;
