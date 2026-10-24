-- trade · fee tiers by 30-day volume (SP-fees-vip-03, J-cex-spot-10 #5-#6)
-- Reversal: 20261024214500_fee_tier_snapshots.down.sql
--
-- An order keeps the fee tier it was placed at, as it keeps its schedule version. Every order before this migration
-- was charged at the regular tier, which the default records.
ALTER TABLE "trade"."orders" ADD COLUMN IF NOT EXISTS "fee_tier" text NOT NULL DEFAULT 'regular';
ALTER TABLE "trade"."orders"
  DROP CONSTRAINT IF EXISTS "orders_fee_tier_ck",
  ADD CONSTRAINT "orders_fee_tier_ck" CHECK (length("fee_tier") BETWEEN 1 AND 64) NOT VALID;
-- NOT VALID: every row before this migration holds the default, which the check accepts.

-- One daily snapshot: the tier each account's counted volume reached over the 30 days before `instant`. A row is a
-- read model, never a balance; `key` is its business key, so a re-run of the snapshot writes nothing new.
CREATE TABLE IF NOT EXISTS "trade"."fee_tier_snapshots" (
  "key"               text PRIMARY KEY,
  "instant"           timestamptz NOT NULL,
  "user_id"           uuid NOT NULL,
  "tier_id"           text NOT NULL,
  "volume_30d"        numeric(38, 18) NOT NULL,
  "counted_fills"     integer NOT NULL,
  "schedule_version"  text NOT NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "fee_tier_snapshots_key_ck"
    CHECK ("key" = 'tier-snapshot:' || to_char("instant" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') || ':' || "user_id"::text),
  CONSTRAINT "fee_tier_snapshots_figures_ck" CHECK ("volume_30d" >= 0 AND "counted_fills" >= 0)
);
CREATE INDEX IF NOT EXISTS "fee_tier_snapshots_user_instant_idx" ON "trade"."fee_tier_snapshots" ("user_id", "instant" DESC);

-- A snapshot is in force once its run row is written, after every account's row: an order placed while a snapshot is
-- still being written keeps the one before it.
CREATE TABLE IF NOT EXISTS "trade"."fee_tier_snapshot_runs" (
  "instant"           timestamptz PRIMARY KEY,
  "schedule_version"  text NOT NULL,
  "accounts"          integer NOT NULL CHECK ("accounts" >= 0),
  "completed_at"      timestamptz NOT NULL DEFAULT now()
);
