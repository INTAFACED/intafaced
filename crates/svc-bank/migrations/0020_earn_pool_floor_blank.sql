-- intafaced:destructive — drops the DEFAULT 0 and the NOT NULL on bank.earn_pools.min_deposit
-- (and re-creates its non-negative CHECK under the same name). Invariants are relaxed, not data:
-- no row is deleted or rewritten, and a stored floor keeps its value. Intended: a blank limit
-- must stay blank instead of silently becoming an allow-all floor of 0. Reversal: the .down.sql.
-- earn_pools.min_deposit DEFAULT 0 stores an allow-all floor when an insert
-- omits the limit. A blank limit is null. An explicit number, including 0,
-- stays that number.
--
-- DROP DEFAULT and DROP NOT NULL only. Stored rows keep the floor they
-- already have.
--
-- The non-negative check stays for a present value. Null passes it.
--
-- Reversal: 0020_earn_pool_floor_blank.down.sql

ALTER TABLE "bank"."earn_pools" ALTER COLUMN "min_deposit" DROP DEFAULT;
ALTER TABLE "bank"."earn_pools" ALTER COLUMN "min_deposit" DROP NOT NULL;

ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_min_deposit_non_negative_ck";
ALTER TABLE "bank"."earn_pools" ADD CONSTRAINT "earn_pools_min_deposit_non_negative_ck"
  CHECK ("min_deposit" IS NULL OR "min_deposit" >= 0);
