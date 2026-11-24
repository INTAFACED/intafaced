-- intafaced:destructive — reversal of 0000_bank_init.sql
--
-- This drops every space name, every standing order, every earn position's
-- terms and the whole interest record. It exists so the migration is provably
-- reversible in CI against a scratch schema (§14).
--
-- It must NEVER be run against a database with live users. Note precisely what
-- is and is not lost: no user's MONEY is here to lose — balances, earn
-- principal and paid interest all live in svc-ledger and survive this file
-- untouched. What dies is the meaning: which pot the user called "Rent", what
-- they instructed to move on the 1st, and which day a pool has already accrued.
-- Losing that last one is the dangerous part — without `interest_accruals` the
-- daily job's first line of defence is gone and a catch-up run would re-pay
-- days the ledger has already settled (the ledger's idempotency keys would
-- still refuse them, which is exactly why there are two).
--
-- The "bank" schema itself is left in place — the bootstrap owns it, not this
-- migration (§2), and this role has no DROP SCHEMA privilege anyway.

DROP TABLE IF EXISTS "bank"."interest_accruals";
DROP TABLE IF EXISTS "bank"."earn_positions";
DROP TABLE IF EXISTS "bank"."earn_pools";
DROP TABLE IF EXISTS "bank"."transfer_executions";
DROP TABLE IF EXISTS "bank"."scheduled_transfers";
DROP TABLE IF EXISTS "bank"."spaces";

DROP TYPE IF EXISTS "bank"."position_status";
DROP TYPE IF EXISTS "bank"."pool_status";
DROP TYPE IF EXISTS "bank"."pool_kind";
DROP TYPE IF EXISTS "bank"."execution_status";
DROP TYPE IF EXISTS "bank"."schedule_status";
DROP TYPE IF EXISTS "bank"."transfer_cadence";
DROP TYPE IF EXISTS "bank"."space_kind";
