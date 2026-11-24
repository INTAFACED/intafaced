-- svc-quant · strategy notification channels and fill alerts (AL-live-06, AL-alerts-01)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. A strategy's chosen channels; its fill alerts, each bound to one strategy version
-- and holding a message template, never a copy of the parameters; and which paper fills each alert has announced, so the
-- server-side sweep publishes each fill once (a crash between publish and mark publishes the same event id again).

CREATE TABLE IF NOT EXISTS "quant"."strategy_notify" (
  "account_id" uuid NOT NULL,
  "strategy_id" text NOT NULL,
  "channels" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "strategy_id")
);

CREATE TABLE IF NOT EXISTS "quant"."strategy_alerts" (
  "id" text PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "strategy_id" text NOT NULL,
  "strategy_version" integer NOT NULL CHECK ("strategy_version" >= 1),
  "template" text NOT NULL CHECK (char_length("template") BETWEEN 1 AND 280),
  "write_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("account_id", "write_key")
);

CREATE INDEX IF NOT EXISTS "strategy_alerts_account_idx" ON "quant"."strategy_alerts" ("account_id", "strategy_id", "created_at");

CREATE TABLE IF NOT EXISTS "quant"."alert_fills" (
  "alert_id" text NOT NULL REFERENCES "quant"."strategy_alerts"("id"),
  "run_id" text NOT NULL,
  "seq" integer NOT NULL CHECK ("seq" >= 0),
  "event_id" text NOT NULL,
  "announced_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("alert_id", "run_id", "seq")
);

CREATE OR REPLACE FUNCTION "quant"."reject_alert_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.alert_immutable — an alert and its announced fills cannot be rewritten';
END;
$$;

DROP TRIGGER IF EXISTS "strategy_alerts_insert_only" ON "quant"."strategy_alerts";
CREATE TRIGGER "strategy_alerts_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."strategy_alerts"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_alert_rewrite"();

DROP TRIGGER IF EXISTS "alert_fills_insert_only" ON "quant"."alert_fills";
CREATE TRIGGER "alert_fills_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."alert_fills"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_alert_rewrite"();
