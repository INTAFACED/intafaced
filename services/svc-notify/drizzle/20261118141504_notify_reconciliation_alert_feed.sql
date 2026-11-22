-- svc-notify · OPS-reconciliation-04 (J-ops-console-07 #10): the finance and platform teams' reconciliation alert feed
-- Reversal: 20261118141504_notify_reconciliation_alert_feed.down.sql
--
-- One row per reconciliation alert transition svc-ops publishes (`intafaced.core-ops.reconciliation_alert.*`), keyed by the
-- event's business key `ops:reconciliation-alert:<alertId>:<sequence>`, so a transition delivered twice is stored once.
-- The row holds ids, states and times only, as the event does: no amount, account or customer data, and no note text.
-- The console shows it on the alert as what the teams were told. No out-of-app channel is sent from it.

CREATE TABLE IF NOT EXISTS "notify"."reconciliation_alert_feed" (
  "event_key" text PRIMARY KEY,
  "alert_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "kind" text NOT NULL,
  "team" text,
  "state" text NOT NULL,
  "actor" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reconciliation_alert_feed_kind_ck"
    CHECK ("kind" IN ('opened', 'acknowledged', 'snoozed', 'unsnoozed', 'reopened', 'resolved', 'accepted')),
  CONSTRAINT "reconciliation_alert_feed_team_ck" CHECK ("team" IS NULL OR "team" IN ('finance', 'platform')),
  CONSTRAINT "reconciliation_alert_feed_sequence_ck" CHECK ("sequence" >= 1),
  CONSTRAINT "reconciliation_alert_feed_alert_sequence_uq" UNIQUE ("alert_id", "sequence")
);
CREATE INDEX IF NOT EXISTS "reconciliation_alert_feed_alert_idx" ON "notify"."reconciliation_alert_feed" ("alert_id", "sequence");
