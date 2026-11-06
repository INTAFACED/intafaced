-- trade.futures_risk_stops · a trader's pre-liquidation stop on one position (D-margin-04, J-derivatives-06 #5)
-- Reversal: 20261105235601_futures_risk_stops.down.sql
--
-- One row per position: the margin ratio (maintenance over equity, 1 = 100%) at which the trader asked the position to
-- be closed before the platform's liquidation. It is a convenience: the liquidation still runs. Blank (no row, or
-- 'cleared') means no stop. The conditional-order tick reads armed rows, and once the ratio reaches the level it claims
-- the row (armed -> fired, one worker wins on the generation) and closes the position through one reduce-only
-- conditional order whose client id is `risk-stop:<position>:<generation>`, so a crash between the claim and the
-- placement replays the same order and never closes twice. Once that close order has ended (filled, failed or
-- cancelled) the row is 'done' and the tick reads it no more; a trader may set a stop again on a position still open.

CREATE TABLE IF NOT EXISTS "trade"."futures_risk_stops" (
  "position_id" uuid PRIMARY KEY REFERENCES "trade"."positions" ("id"),
  "user_id" text NOT NULL,
  "level" numeric(38, 18),
  "status" text NOT NULL,
  "generation" integer NOT NULL DEFAULT 1,
  "client_request_id" text NOT NULL,
  "close_client_order_id" text,
  "fired_ratio" numeric(38, 18),
  "fired_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "futures_risk_stops_status_ck" CHECK ("status" IN ('armed', 'fired', 'done', 'cleared', 'ended')),
  CONSTRAINT "futures_risk_stops_level_ck" CHECK ("level" IS NULL OR ("level" > 0 AND "level" < 1)),
  CONSTRAINT "futures_risk_stops_armed_level_ck" CHECK ("status" <> 'armed' OR "level" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "futures_risk_stops_armed_idx"
  ON "trade"."futures_risk_stops" ("status")
  WHERE "status" IN ('armed', 'fired');
