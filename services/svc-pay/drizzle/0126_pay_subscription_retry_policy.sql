-- M-bill-04: per-merchant subscription retry policy (attempts, spacing, final action, auto-retry switch).
-- The three values are OWNER DECISIONS and have no default: NULL means unset, and auto_retry cannot be true
-- unless all three are set (CHECK below, and the service refuses first with pay.subscription_retry_policy_unset).
-- attempts is capped at 3, the charge-cycle bound MAX_ATTEMPTS_PER_CYCLE (subscriptions/charge-cycle.ts).
-- Versioned: every write names the version it read; the history table keeps every accepted write.
CREATE TABLE IF NOT EXISTS "pay"."subscription_retry_policies" (
  "merchant_id" uuid PRIMARY KEY REFERENCES "pay"."merchants"("id"),
  "attempts" integer CHECK ("attempts" IS NULL OR ("attempts" BETWEEN 1 AND 3)),
  "spacing_hours" integer CHECK ("spacing_hours" IS NULL OR ("spacing_hours" BETWEEN 1 AND 720)),
  "final_action" text CHECK ("final_action" IS NULL OR "final_action" IN ('cancel', 'mark_unpaid', 'leave_past_due')),
  "auto_retry" boolean NOT NULL DEFAULT false,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_retry_policies_auto_needs_values"
    CHECK (NOT "auto_retry" OR ("attempts" IS NOT NULL AND "spacing_hours" IS NOT NULL AND "final_action" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "pay"."subscription_retry_policy_events" (
  "seq" bigserial PRIMARY KEY,
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "version" integer NOT NULL,
  "attempts" integer,
  "spacing_hours" integer,
  "final_action" text,
  "auto_retry" boolean NOT NULL,
  "actor_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("merchant_id", "version")
);
