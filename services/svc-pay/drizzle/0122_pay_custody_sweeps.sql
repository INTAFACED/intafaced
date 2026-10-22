-- Sweeps from customer deposit addresses to treasury (W-custody-ops-05, wallet-custody-ops-067). CUSTODY SIDE ONLY: a sweep
-- moves coins between our own addresses on chain and never changes a customer balance or posts to the ledger (ENGINE D-5).
-- The policy is owner-set per (network, asset), changes only through an approved custody config task, and is append-only; the latest row is the policy and a pair with none refuses
-- every sweep. One intent row per business key `sweep:<depositId>:<tier>` is written before the rail is asked; an unknown
-- broadcast keeps it, and a retry reuses the same key.
CREATE TABLE IF NOT EXISTS "pay"."custody_sweep_policy_events" (
  "seq" bigserial PRIMARY KEY,
  "network_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "trigger" text NOT NULL,
  "threshold_amount" numeric(38,18),
  "threshold_count" integer,
  "schedule_minutes" integer,
  "treasury_address" text NOT NULL,
  "reason" text NOT NULL,
  "set_by" text NOT NULL,
  -- The approved custody config task (scope `policy`, kind `sweep_policy`) that wrote this row, and its approvers.
  "approval_task_id" uuid NOT NULL,
  "approved_by" text[] NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_sweep_policy_dual_ck" CHECK (cardinality("approved_by") > 0 AND NOT ("set_by" = ANY ("approved_by"))),
  CONSTRAINT "custody_sweep_policy_trigger_ck" CHECK (
    ("trigger" = 'immediate' AND "threshold_amount" IS NULL AND "threshold_count" IS NULL AND "schedule_minutes" IS NULL)
    OR ("trigger" = 'amount' AND "threshold_amount" IS NOT NULL AND "threshold_count" IS NULL AND "schedule_minutes" IS NULL)
    OR ("trigger" = 'count' AND "threshold_count" >= 1 AND "threshold_amount" IS NULL AND "schedule_minutes" IS NULL)
    OR ("trigger" = 'schedule' AND "schedule_minutes" >= 1 AND "threshold_amount" IS NULL AND "threshold_count" IS NULL)
  ),
  CONSTRAINT "custody_sweep_policy_amount_ck" CHECK ("threshold_amount" IS NULL OR "threshold_amount" > 0),
  CONSTRAINT "custody_sweep_policy_text_ck" CHECK (length(btrim("network_id")) > 0 AND length(btrim("asset_id")) > 0
    AND length(btrim("treasury_address")) > 0 AND "treasury_address" !~ '\s' AND length(btrim("reason")) > 0 AND length(btrim("set_by")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "custody_sweep_policy_task_uq" ON "pay"."custody_sweep_policy_events" ("approval_task_id");
CREATE INDEX IF NOT EXISTS "custody_sweep_policy_pair_idx" ON "pay"."custody_sweep_policy_events" ("network_id", "asset_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."custody_sweeps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL,
  -- No foreign key: the deposit record tables are truncated as a group by their own tests, and the service checks the
  -- deposit exists and is credited before it writes the intent.
  "deposit_id" uuid NOT NULL,
  "tier" text NOT NULL,
  "network_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "from_address" text NOT NULL,
  "to_address" text NOT NULL,
  "amount" numeric(38,18) NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "tx_hash" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_by" text NOT NULL,
  "last_executed_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_sweeps_key_ck" CHECK ("idempotency_key" = 'sweep:' || "deposit_id"::text || ':' || "tier"),
  CONSTRAINT "custody_sweeps_tier_ck" CHECK ("tier" IN ('treasury')),
  CONSTRAINT "custody_sweeps_status_ck" CHECK ("status" IN ('pending', 'broadcasting', 'unknown', 'failed', 'broadcast')),
  CONSTRAINT "custody_sweeps_tx_ck" CHECK (("status" = 'broadcast') = ("tx_hash" IS NOT NULL)),
  CONSTRAINT "custody_sweeps_amount_ck" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "custody_sweeps_key_uq" ON "pay"."custody_sweeps" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "custody_sweeps_pair_idx" ON "pay"."custody_sweeps" ("network_id", "asset_id", "created_at" DESC);
