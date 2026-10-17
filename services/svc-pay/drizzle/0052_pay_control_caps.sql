-- W1 MERCHANT CONTROL ROOM (3/5): row-locked cap counters.
--
-- One counter row per (merchant, cap kind, asset, UTC period). The guard takes
-- the row FOR UPDATE inside the admission transaction, AFTER the merchant lock
-- (seams/guards.ts lock order), so the check-and-add is exact under concurrency.
-- `control_cap_events` makes the add idempotent by business key: the same
-- payment or payout attempt is counted once however many times a hook runs.

CREATE TABLE IF NOT EXISTS "pay"."control_cap_usage" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "cap_kind"    text NOT NULL CONSTRAINT "control_cap_usage_kind_known" CHECK ("cap_kind" IN ('daily_intake', 'monthly_intake', 'daily_payout', 'beneficiaries_per_day')),
  -- '' for the beneficiary count, which has no asset.
  "asset_code"  text NOT NULL,
  -- UTC day 'YYYY-MM-DD' or month 'YYYY-MM'.
  "period_key"  text NOT NULL,
  "used"        numeric(60, 18) NOT NULL DEFAULT 0 CONSTRAINT "control_cap_usage_nonneg" CHECK ("used" >= 0),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "cap_kind", "asset_code", "period_key")
);

CREATE TABLE IF NOT EXISTS "pay"."control_cap_events" (
  "event_key"   text NOT NULL CONSTRAINT "control_cap_events_key_not_blank" CHECK (length(btrim("event_key")) > 0),
  "cap_kind"    text NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "asset_code"  text NOT NULL,
  "period_key"  text NOT NULL,
  "amount"      numeric(60, 18) NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("event_key", "cap_kind")
);
CREATE INDEX IF NOT EXISTS "control_cap_events_merchant_idx" ON "pay"."control_cap_events" ("merchant_id", "created_at" DESC);

-- Distinct payout destinations used in a UTC day (the beneficiary cap).
CREATE TABLE IF NOT EXISTS "pay"."control_beneficiaries" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "period_key"  text NOT NULL,
  "destination" text NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "period_key", "destination")
);
