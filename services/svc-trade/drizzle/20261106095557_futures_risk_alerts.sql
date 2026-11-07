-- Futures margin and liquidation-risk alerts (D-account-03, J-derivatives-06 #6)
-- Reversal: 20261106095557_futures_risk_alerts.down.sql
--
-- 1. trade.position_margin_calls.announced_at: when `tradeMarginCalled` for that call was published. The margin call is
--    the liquidation warning, always on: svc-trade writes the call, then tells svc-notify once per call. A healthy tick
--    now ends the open call (cleared_at), so the next fall is a new call with the next sequence.
-- 2. trade.futures_risk_alert_levels: a trader's own liquidation-risk levels, margin ratios (maintenance over equity,
--    1 = 100%) strictly between 0 and 1, and whether the alert is on. Blank (no row, or no levels) cannot be turned on:
--    the trader sees "set your risk levels". No level is ever filled in for them.
-- 3. trade.futures_risk_alert_crossings: one row per crossing of one level by one position. A crossing starts when the
--    ratio reaches the level and ends when it is back under it, so the next rise is the next generation: one alert per
--    crossing, keyed (position, level, generation). announced_at records that its alert was published.

ALTER TABLE "trade"."position_margin_calls"
  ADD COLUMN IF NOT EXISTS "announced_at" timestamptz;

CREATE TABLE IF NOT EXISTS "trade"."futures_risk_alert_levels" (
  "user_id" text PRIMARY KEY,
  "levels" numeric(38, 18)[] NOT NULL DEFAULT '{}',
  "enabled" boolean NOT NULL DEFAULT false,
  "client_request_id" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "futures_risk_alert_levels_on_needs_levels_ck" CHECK (NOT "enabled" OR cardinality("levels") >= 1),
  CONSTRAINT "futures_risk_alert_levels_count_ck" CHECK (cardinality("levels") <= 10)
);

CREATE TABLE IF NOT EXISTS "trade"."futures_risk_alert_crossings" (
  "position_id" uuid NOT NULL REFERENCES "trade"."positions" ("id"),
  "level" numeric(38, 18) NOT NULL,
  "generation" integer NOT NULL,
  "user_id" text NOT NULL,
  "market_id" text NOT NULL,
  "symbol" text NOT NULL,
  "ratio" numeric(38, 18) NOT NULL,
  "crossed_at" timestamptz NOT NULL,
  "ended_at" timestamptz,
  "announced_at" timestamptz,
  PRIMARY KEY ("position_id", "level", "generation"),
  CONSTRAINT "futures_risk_alert_crossings_level_ck" CHECK ("level" > 0 AND "level" < 1),
  CONSTRAINT "futures_risk_alert_crossings_generation_ck" CHECK ("generation" >= 1)
);

-- At most one open crossing per position and level: a re-tick above the level is the same crossing.
CREATE UNIQUE INDEX IF NOT EXISTS "futures_risk_alert_crossings_open_uidx"
  ON "trade"."futures_risk_alert_crossings" ("position_id", "level")
  WHERE "ended_at" IS NULL;

CREATE INDEX IF NOT EXISTS "futures_risk_alert_crossings_user_idx"
  ON "trade"."futures_risk_alert_crossings" ("user_id", "crossed_at" DESC);
