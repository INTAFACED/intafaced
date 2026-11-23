-- Staking-style earn pools and pool status (BK-earn-04, J-bank-08 #6).
--
-- `earn_pools.unbonding_days` makes a flexible pool staking-style: a saving taken back first unbonds for that many days
-- (no interest, no money moves), then the bank releases it to the main balance through the same withdraw recipe as any
-- flexible saving. Null is a pool without unbonding; only a flexible pool can have one, since a fixed term already has
-- its own lock.
--
-- `earn_positions.unbonding_started_at` / `unbonds_at` are the saving's unbonding request, written once: a request sent
-- twice finds them set and makes no second one.
--
-- `earn_pools.status_revision` counts the pool's status changes, and `earn_pool_status_changes` records each one under
-- (pool, revision), the change's business key `pool-status:<poolId>:<revision>`, with the four-eyes approval that made
-- it and both people. A status is a pool-level pause on new savings only; it neither reads nor sets an account or posting freeze.
--
-- Reversal: 20261029203714_earn_unbonding.down.sql (refuses while any pool unbonds, a saving is unbonding or a status
-- change is recorded).

ALTER TABLE "bank"."earn_pools" ADD COLUMN IF NOT EXISTS "unbonding_days" integer;
ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_unbonding_flexible_ck";
ALTER TABLE "bank"."earn_pools" ADD CONSTRAINT "earn_pools_unbonding_flexible_ck"
  CHECK ("unbonding_days" IS NULL OR ("kind" = 'flexible' AND "unbonding_days" > 0 AND "unbonding_days" <= 365));

ALTER TABLE "bank"."earn_pools" ADD COLUMN IF NOT EXISTS "status_revision" integer NOT NULL DEFAULT 0;
ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_status_revision_ck";
ALTER TABLE "bank"."earn_pools" ADD CONSTRAINT "earn_pools_status_revision_ck" CHECK ("status_revision" >= 0);

ALTER TABLE "bank"."earn_positions" ADD COLUMN IF NOT EXISTS "unbonding_started_at" timestamptz;
ALTER TABLE "bank"."earn_positions" ADD COLUMN IF NOT EXISTS "unbonds_at" timestamptz;
ALTER TABLE "bank"."earn_positions" DROP CONSTRAINT IF EXISTS "earn_positions_unbonding_pair_ck";
ALTER TABLE "bank"."earn_positions" ADD CONSTRAINT "earn_positions_unbonding_pair_ck"
  CHECK (("unbonding_started_at" IS NULL AND "unbonds_at" IS NULL)
      OR ("unbonding_started_at" IS NOT NULL AND "unbonds_at" > "unbonding_started_at"));

-- The release job's sweep: savings whose unbonding has ended.
CREATE INDEX IF NOT EXISTS "earn_positions_unbonds_at_idx" ON "bank"."earn_positions" ("unbonds_at")
  WHERE "status" = 'active' AND "unbonds_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "bank"."earn_pool_status_changes" (
  "pool_id" uuid NOT NULL REFERENCES "bank"."earn_pools" ("id"),
  "revision" integer NOT NULL,
  "status" "bank"."pool_status" NOT NULL,
  "previous_status" "bank"."pool_status" NOT NULL,
  "reason" text NOT NULL,
  "approval_id" text NOT NULL,
  "requested_by" text NOT NULL,
  "approved_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("pool_id", "revision"),
  CONSTRAINT "earn_pool_status_changes_revision_ck" CHECK ("revision" > 0),
  CONSTRAINT "earn_pool_status_changes_changed_ck" CHECK ("status" <> "previous_status")
);

CREATE OR REPLACE FUNCTION "bank"."earn_pool_status_changes_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'earn_pool_status_changes row (%, %) is append-only: an approved status change stays recorded', OLD."pool_id", OLD."revision"
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER "earn_pool_status_changes_append_only_trg"
  BEFORE UPDATE OR DELETE ON "bank"."earn_pool_status_changes"
  FOR EACH ROW EXECUTE FUNCTION "bank"."earn_pool_status_changes_append_only"();
