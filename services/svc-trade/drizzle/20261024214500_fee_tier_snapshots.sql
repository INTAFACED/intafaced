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

-- Whether the order's fills count toward its owner's fee tier, decided when it is placed and never after: false for an
-- order placed for the person by copy trading, an algorithm or an execution child, for a sub-account's order, and for
-- the house market maker. Rows before this migration are marked from what they show: their client ids, their sub
-- account, their seed flag and the copy mirror claims. A copy flatten whose id was hashed cannot be told apart here and
-- stays counted; every order placed from now on is marked by the path that placed it.
ALTER TABLE "trade"."orders" ADD COLUMN IF NOT EXISTS "tier_volume" boolean NOT NULL DEFAULT true;
UPDATE "trade"."orders" o
   SET "tier_volume" = false
 WHERE o."tier_volume"
   AND (o."seeded"
     OR o."sub_account_id" IS NOT NULL
     OR o."client_order_id" LIKE 'algo:%'
     OR o."client_order_id" LIKE '%/client/%'
     OR o."client_order_id" LIKE 'copy-flatten:%'
     OR o."client_order_id" LIKE 'copy-mirror:%'
     OR EXISTS (SELECT 1 FROM "trade"."copy_placed_mirrors" cm WHERE cm."order_id" = o."id"::text));

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
