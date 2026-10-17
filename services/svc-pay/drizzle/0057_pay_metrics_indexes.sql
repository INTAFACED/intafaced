-- svc-pay · W2 metrics read model: source-side indexes for the per-day recompute.
-- Reversal: 0057_pay_metrics_indexes.down.sql
--
-- The recompute asks "captured / refunded events in this UTC day" and "settlements
-- created in this day". Without these it scans every event or every settlement.
CREATE INDEX IF NOT EXISTS "payment_events_metrics_ts_idx" ON "pay"."payment_events" ("ts")
  WHERE "event" IN ('captured', 'refunded');
CREATE INDEX IF NOT EXISTS "settlements_metrics_created_idx" ON "pay"."settlements" ("created_at");
