-- BK-acct-08 (J-bank-16 #4, #5): budgets by spend category. A budget is the person's POLICY: a monthly target for one
-- category in one asset, and the share of it at which they want an alert (basis points, chosen by them; no default).
-- What was spent is never stored: it is folded from the ledger every time it is read (analytics/spend.ts).
CREATE TABLE IF NOT EXISTS "bank"."budgets" (
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "category" text NOT NULL,
  -- POLICY: the person's target for one month. Not a balance and not a running total.
  "target" numeric(38, 18) NOT NULL,
  "alert_bps" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "budgets_pk" PRIMARY KEY ("user_id", "asset_id", "category"),
  CONSTRAINT "budgets_target_positive" CHECK ("target" > 0),
  CONSTRAINT "budgets_alert_bps_range" CHECK ("alert_bps" > 0 AND "alert_bps" <= 10000)
);

-- A RECORD that the person was shown a budget's alert in one month (`budget-alert:<user>:<asset>:<category>:<YYYY-MM>`),
-- written once, so the alert shows once per period.
CREATE TABLE IF NOT EXISTS "bank"."budget_alert_notices" (
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "category" text NOT NULL,
  "period" text NOT NULL,
  "shown_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "budget_alert_notices_pk" PRIMARY KEY ("user_id", "asset_id", "category", "period"),
  CONSTRAINT "budget_alert_notices_period_ck" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$')
);
