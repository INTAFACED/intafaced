-- svc-bank — auto-invest F-plane half (bank.auto-invest / §31:805)
--
-- Schedules and rules only. No balance column. Value moves only via existing
-- ledger recipes (earnDeposit for threshold sweeps; convert port for DCA when
-- wired). Cross-asset DCA without a rate counterparty refuses by name —
-- never invents §8 rates.

CREATE TYPE "bank"."auto_invest_kind" AS ENUM ('threshold_sweep', 'dca');
CREATE TYPE "bank"."auto_invest_rule_status" AS ENUM ('active', 'paused', 'cancelled');
CREATE TYPE "bank"."auto_invest_run_status" AS ENUM ('pending', 'settled', 'rejected', 'skipped');

CREATE TABLE IF NOT EXISTS "bank"."auto_invest_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "kind" "bank"."auto_invest_kind" NOT NULL,
  -- Source asset: for threshold_sweep, primary-space balance of this asset;
  -- for dca, the asset spent on each firing (convert would buy the target).
  "asset_id" text NOT NULL,
  -- threshold_sweep: keep this much in primary; move excess into the pool.
  "threshold" numeric(38, 18),
  "target_pool_id" uuid,
  -- dca: buy this asset (requires a convert port — refuse without inventing rates).
  "buy_asset_id" text,
  "amount" numeric(38, 18),
  "cadence" "bank"."transfer_cadence",
  "next_run_at" timestamptz,
  "status" "bank"."auto_invest_rule_status" NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "auto_invest_rules_kind_shape" CHECK (
    (
      "kind" = 'threshold_sweep'
      AND "threshold" IS NOT NULL AND "threshold" > 0
      AND "target_pool_id" IS NOT NULL
      AND "buy_asset_id" IS NULL AND "amount" IS NULL
      AND "cadence" IS NULL AND "next_run_at" IS NULL
    )
    OR
    (
      "kind" = 'dca'
      AND "amount" IS NOT NULL AND "amount" > 0
      AND "buy_asset_id" IS NOT NULL
      AND "cadence" IS NOT NULL AND "next_run_at" IS NOT NULL
      AND "threshold" IS NULL AND "target_pool_id" IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS "auto_invest_rules_user_idx"
  ON "bank"."auto_invest_rules" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "auto_invest_rules_active_idx"
  ON "bank"."auto_invest_rules" ("status")
  WHERE "status" = 'active';

-- One run record per claim. Amount is a RECORD of what moved (or would have);
-- never a running total. Unique (rule_id, client_run_id) so a re-drive is the
-- same claim, not a second movement.
CREATE TABLE IF NOT EXISTS "bank"."auto_invest_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "rule_id" uuid NOT NULL REFERENCES "bank"."auto_invest_rules" ("id"),
  "client_run_id" text NOT NULL,
  "status" "bank"."auto_invest_run_status" NOT NULL DEFAULT 'pending',
  "amount" numeric(38, 18),
  "ledger_tx_id" text,
  "position_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "auto_invest_runs_amount_positive" CHECK ("amount" IS NULL OR "amount" > 0),
  CONSTRAINT "auto_invest_runs_unique_claim" UNIQUE ("rule_id", "client_run_id")
);

CREATE INDEX IF NOT EXISTS "auto_invest_runs_rule_idx"
  ON "bank"."auto_invest_runs" ("rule_id", "created_at");
