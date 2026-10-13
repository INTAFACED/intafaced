-- trade.futures · liquidation rungs (a state machine on one position row)
-- Reversal: 0050_liquidation_rung_plans.down.sql
--
-- A liquidation rung is one tranche of a liquidation (a partial reduction, or the
-- closing rung). Each rung gets a rung_id and is written down BEFORE its first
-- ledger post: the recipes (amounts as decimal strings), the size closed, the
-- margin left, and the position row it was planned against (from_size,
-- from_margin). A replay after a crash posts THESE bodies, never a re-plan at a
-- new mark, so one idempotency key never carries two sets of amounts.
--
-- The rung_id is part of every ledger key the rung posts (loss and margin
-- release), so a row that regrows to an earlier size at the same mark can never
-- collide with a key an older rung already booked.
--
--   planned    written, not (known to be) fully posted
--   posted     every recipe is booked in the ledger; the row has not moved yet
--   applied    the row moved by the plan (same transaction as this state)
--   abandoned  the row changed under a rung whose loss may already be booked.
--              Loud operator signal (trade.liquidation_row_changed_after_post);
--              never reported as success.
--
-- AT MOST ONE LIVE RUNG PER POSITION: the partial unique index below covers
-- planned and posted. Two replicas that plan the same position converge on one
-- rung; the loser reads the winner's and replays it.
--
-- DEPLOY: rungs that were in flight under the old (claim-based) code have a row in
-- trade.liquidation_attempts and no row here; the tick keeps treating those as
-- before (no plan, old keys), so a deploy cannot book one loss twice.
--
-- RETENTION: applied and abandoned rows are history and are never read by the
-- tick. No cleanup job yet; the table grows by one row per rung. Index
-- liquidation_rung_plans_position_idx serves the per-position history lookup.
--
-- Plan IDENTITY only, never a balance. The ledger remains the only book of money.

CREATE TABLE IF NOT EXISTS "trade"."liquidation_rung_plans" (
  "rung_id"     uuid PRIMARY KEY,
  "position_id" text NOT NULL,
  "kind"        text NOT NULL,
  "from_size"   numeric NOT NULL,
  "from_margin" numeric NOT NULL,
  "plan"        jsonb NOT NULL,
  "state"       text NOT NULL DEFAULT 'planned',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "trade"."liquidation_rung_plans" DROP CONSTRAINT IF EXISTS "liquidation_rung_plans_kind_ck";
ALTER TABLE "trade"."liquidation_rung_plans" ADD CONSTRAINT "liquidation_rung_plans_kind_ck"
  CHECK ("kind" IN ('partial', 'closing'));

ALTER TABLE "trade"."liquidation_rung_plans" DROP CONSTRAINT IF EXISTS "liquidation_rung_plans_state_ck";
ALTER TABLE "trade"."liquidation_rung_plans" ADD CONSTRAINT "liquidation_rung_plans_state_ck"
  CHECK ("state" IN ('planned', 'posted', 'applied', 'abandoned'));

CREATE UNIQUE INDEX IF NOT EXISTS "liquidation_rung_plans_one_live_idx"
  ON "trade"."liquidation_rung_plans" ("position_id")
  WHERE "state" IN ('planned', 'posted');

CREATE INDEX IF NOT EXISTS "liquidation_rung_plans_position_idx"
  ON "trade"."liquidation_rung_plans" ("position_id", "created_at");
