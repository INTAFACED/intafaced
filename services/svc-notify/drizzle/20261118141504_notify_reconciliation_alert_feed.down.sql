-- intafaced:destructive — reversal of 20261118141504_notify_reconciliation_alert_feed.sql
-- The teams' record of reconciliation alert transitions is dropped; svc-ops keeps every alert and its timeline.

DROP TABLE IF EXISTS "notify"."reconciliation_alert_feed";
