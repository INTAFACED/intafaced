-- J-charts-desk-18 #5 #6 (C-ops-04, C-alerts-scan-03): the alert owner values the founder sets on the charts settings
-- page: the price-alert quota per plan (the account's verification level) and the trigger-log retention. One append-only
-- row per write; the newest row for a (key, plan) is what applies. Each row is its own audit: who, when, the old and new
-- value, and the reason. A null value is "not set" and refuses the action that needs it. svc-notify `alerts/owner-values.ts`.
CREATE TABLE IF NOT EXISTS "notify"."alert_owner_values" (
  "id" bigserial PRIMARY KEY,
  "key" text NOT NULL CHECK ("key" IN ('priceQuota', 'triggerLogDays')),
  "plan" text CHECK ("plan" IS NULL OR "plan" IN ('none', 'basic', 'full', 'institutional')),
  "value" integer CHECK ("value" IS NULL OR "value" > 0),
  "old_value" integer,
  "operator_id" text NOT NULL,
  "reason" text NOT NULL CHECK (length(btrim("reason")) >= 12),
  "client_request_id" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CHECK (("key" = 'priceQuota') = ("plan" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "alert_owner_values_slot_idx" ON "notify"."alert_owner_values" ("key", (coalesce("plan", '')), "id" DESC);
