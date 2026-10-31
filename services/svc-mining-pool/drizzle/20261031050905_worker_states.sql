-- svc-mining-pool · worker connectivity, maintenance and alert limits (J-more-catalogue-06 #3, #4, #6).
-- Reversal: 20261031050905_worker_states.down.sql
-- A worker's state changes are recorded facts, one row per change, keyed by a business key so a repeat evaluation (or a
-- second evaluator) writes nothing new. The evaluator's last look at each worker is kept beside them. Maintenance is one
-- row per worker that is in it. The alert limit is the account's own choice per worker; no row is no choice.

CREATE TABLE IF NOT EXISTS "mining_pool"."worker_state_changes" (
  "key"           text PRIMARY KEY,
  "seq"           bigint GENERATED ALWAYS AS IDENTITY,
  "worker_id"     text NOT NULL REFERENCES "mining_pool"."workers" ("id"),
  "user_id"       text NOT NULL,
  "from_state"    text NOT NULL,
  "to_state"      text NOT NULL,
  "last_share_at" timestamptz,
  "at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "worker_state_changes_from_ck" CHECK ("from_state" IN ('online', 'offline')),
  CONSTRAINT "worker_state_changes_to_ck" CHECK ("to_state" IN ('online', 'offline')),
  CONSTRAINT "worker_state_changes_moves_ck" CHECK ("from_state" <> "to_state"),
  CONSTRAINT "worker_state_changes_key_ck" CHECK (length(btrim("key")) > 0)
);

CREATE INDEX IF NOT EXISTS "worker_state_changes_worker_seq_idx"
  ON "mining_pool"."worker_state_changes" ("worker_id", "seq" DESC);

-- Each change follows the worker's previous recorded change (`prev_seq`; NULL for its first), and one recorded change has
-- at most one successor. The key names that previous change too, so a state that returns under the same newest share
-- (the owner moved the quiet interval and back) is a new key, and two evaluators that saw the same previous change
-- collide here and write one row.
ALTER TABLE "mining_pool"."worker_state_changes" ADD COLUMN IF NOT EXISTS "prev_seq" bigint;

CREATE UNIQUE INDEX IF NOT EXISTS "worker_state_changes_successor_uidx"
  ON "mining_pool"."worker_state_changes" ("worker_id", COALESCE("prev_seq", 0));

-- A share stored before workers were labelled counts for the worker id it was sent under (`myWorkers` counts it so), and
-- the worker's state reads its newest such share too.
CREATE INDEX IF NOT EXISTS "shares_unlabelled_miner_created_idx"
  ON "mining_pool"."shares" ("miner_id", "created_at")
  WHERE "worker_id" IS NULL;

CREATE TABLE IF NOT EXISTS "mining_pool"."worker_evaluations" (
  "worker_id"    text PRIMARY KEY REFERENCES "mining_pool"."workers" ("id"),
  "evaluated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "mining_pool"."worker_maintenance" (
  "worker_id"  text PRIMARY KEY REFERENCES "mining_pool"."workers" ("id"),
  "user_id"    text NOT NULL,
  "key"        text NOT NULL,
  "since"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "worker_maintenance_key_uq" UNIQUE ("key")
);

CREATE INDEX IF NOT EXISTS "worker_maintenance_user_idx"
  ON "mining_pool"."worker_maintenance" ("user_id");

CREATE TABLE IF NOT EXISTS "mining_pool"."worker_alert_limits" (
  "worker_id"    text PRIMARY KEY REFERENCES "mining_pool"."workers" ("id"),
  "user_id"      text NOT NULL,
  "mode"         text NOT NULL,
  "manual_limit" numeric(38, 18),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "worker_alert_limits_mode_ck" CHECK ("mode" IN ('automatic', 'manual')),
  CONSTRAINT "worker_alert_limits_manual_ck" CHECK (
    ("mode" = 'manual' AND "manual_limit" IS NOT NULL AND "manual_limit" > 0)
    OR ("mode" = 'automatic' AND "manual_limit" IS NULL)
  )
);
