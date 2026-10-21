-- Reversal of 0021_notify_alert_triggers.sql. The trigger history is dropped; alerts themselves are untouched.
DROP TABLE IF EXISTS "notify"."alert_triggers";
