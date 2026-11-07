-- intafaced:destructive drops the alert owner values added by the up migration; the deployment settings apply again.
DROP TABLE IF EXISTS "notify"."alert_owner_values";
