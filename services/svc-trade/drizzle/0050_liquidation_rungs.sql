-- trade.futures · liquidation rungs (a state machine on one position row)
-- Reversal: 0050_liquidation_rungs.down.sql
--
-- A liquidation rung is one tranche of a liquidation (a partial reduction, or the
-- closing rung). Each rung gets a rung_id and is written down BEFORE its first
-- ledger post: the recipes (amounts as decimal strings), the size closed, the
-- margin its loss takes, and the position row it was planned against (from_size,
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
--   abandoned  the loss is booked and the row cannot be reconciled with it (closed,
--              no larger than the tranche, or a closing rung whose release no
--              longer matches the row's margin). The position is PARKED: no new
--              rung is planned while its latest rung is abandoned. Loud operator
--              signal (trade.liquidation_row_changed_after_post).
--   resolved   an operator reconciled an abandoned rung by hand and released the park:
--                UPDATE trade.liquidation_rungs SET state = 'resolved' WHERE rung_id = …
--
-- AT MOST ONE LIVE RUNG PER POSITION: the partial unique index below covers
-- planned and posted. Two replicas that plan the same position converge on one
-- rung; the loser reads the winner's and replays it.
--
-- announced_at: a closing rung closes its row inside the rung transaction; the bus
-- announcement is a separate step. announced_at records that it published, so a
-- crash between the two is found and re-published (the publish key makes a repeat
-- harmless). NULL on an applied closing rung means "not yet announced".
--
-- DEPLOY: rungs that were in flight under the old (claim-based) code have a row in
-- trade.liquidation_attempts and no row here; the tick keeps treating those as
-- before (no plan, old keys), so a deploy cannot book one loss twice.
--
-- RETENTION: applied and resolved rows are history and are never read by the tick
-- except the unannounced scan. No cleanup job yet; the table grows by one row per
-- rung. Index liquidation_rungs_position_idx serves the per-position lookups.
--
-- Rung IDENTITY only, never a balance. The ledger remains the only book of money.

CREATE TABLE IF NOT EXISTS "trade"."liquidation_rungs" (
  "rung_id"        uuid PRIMARY KEY,
  "position_id"    text NOT NULL,
  "liquidation_id" text NOT NULL,
  "kind"           text NOT NULL,
  "from_size"      numeric NOT NULL,
  "from_margin"    numeric NOT NULL,
  "plan"           jsonb NOT NULL,
  "state"          text NOT NULL DEFAULT 'planned',
  "announced_at"   timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "trade"."liquidation_rungs" DROP CONSTRAINT IF EXISTS "liquidation_rungs_kind_ck";
ALTER TABLE "trade"."liquidation_rungs" ADD CONSTRAINT "liquidation_rungs_kind_ck"
  CHECK ("kind" IN ('partial', 'closing'));

ALTER TABLE "trade"."liquidation_rungs" DROP CONSTRAINT IF EXISTS "liquidation_rungs_state_ck";
ALTER TABLE "trade"."liquidation_rungs" ADD CONSTRAINT "liquidation_rungs_state_ck"
  CHECK ("state" IN ('planned', 'posted', 'applied', 'abandoned', 'resolved'));

CREATE UNIQUE INDEX IF NOT EXISTS "liquidation_rungs_one_live_idx"
  ON "trade"."liquidation_rungs" ("position_id")
  WHERE "state" IN ('planned', 'posted');

CREATE INDEX IF NOT EXISTS "liquidation_rungs_position_idx"
  ON "trade"."liquidation_rungs" ("position_id", "created_at");

CREATE INDEX IF NOT EXISTS "liquidation_rungs_unannounced_idx"
  ON "trade"."liquidation_rungs" ("created_at")
  WHERE "kind" = 'closing' AND "state" = 'applied' AND "announced_at" IS NULL;
