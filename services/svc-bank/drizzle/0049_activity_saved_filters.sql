-- Saved activity filters (BK-acct-07, accounts-insights-055): a customer names a set of activity.list filters and
-- reuses it. A filter is not money and holds no balance. The name is the business key per customer: saving the same
-- name with the same filter replays, with a different filter it is refused.
--
-- Reversal: 0049_activity_saved_filters.down.sql

CREATE TABLE IF NOT EXISTS "bank"."activity_saved_filters" (
  "user_id" uuid NOT NULL,
  "name" text NOT NULL,
  "filter" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "name"),
  CONSTRAINT "activity_saved_filters_name_len" CHECK (char_length("name") BETWEEN 1 AND 60)
);
