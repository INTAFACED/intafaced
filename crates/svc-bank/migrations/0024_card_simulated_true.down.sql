-- 0003 left simulated NOT NULL DEFAULT true and did not check the flag.
-- The forward migration rewrote no row, so dropping the check returns the
-- table to the shape it had before.

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_simulated_true";
