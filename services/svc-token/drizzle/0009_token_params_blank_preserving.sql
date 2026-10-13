-- intafaced:destructive — drops NOT NULL and DEFAULT on token.token_params columns for books that already applied
-- 0000 before parameters could stay blank. Invariants are relaxed, not data: existing values are preserved exactly,
-- no row is deleted, and no supply, rate, fee or split is written. Reversal: the .down.sql.
-- Upgrade books that already recorded 0000 before token parameters could stay
-- blank. This only relaxes nullability and JSON defaults. Existing parameter
-- values are preserved exactly; no supply, rate, fee, or split is written.

ALTER TABLE "token"."token_params" ALTER COLUMN "total_supply" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "emission_curve" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "emission_curve" DROP DEFAULT;
ALTER TABLE "token"."token_params" ALTER COLUMN "halving_interval" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "fee_discount_schedule" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "fee_discount_schedule" DROP DEFAULT;
ALTER TABLE "token"."token_params" ALTER COLUMN "buyback_bps" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "burn_split_bps" DROP NOT NULL;
