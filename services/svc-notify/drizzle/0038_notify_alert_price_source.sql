-- svc-notify · J-charts-desk-09 #2 alert price source
-- Reversal: 0038_notify_alert_price_source.down.sql
--
-- A price alert is evaluated against the price the person chose: 'mark' (mid of bid and ask when the book is two-sided, else
-- last: what every alert used before this migration), 'bid', 'ask' or 'last'. Existing rows keep 'mark', so nothing they do
-- changes. A side the ticker does not carry refuses the evaluation; it never falls back to another side.

ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'mark';
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_source_ck";
ALTER TABLE "notify"."price_alerts" ADD CONSTRAINT "price_alerts_source_ck" CHECK ("source" IN ('mark', 'bid', 'ask', 'last'));
