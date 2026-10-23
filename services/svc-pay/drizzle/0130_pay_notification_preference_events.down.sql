-- intafaced:destructive — reversal of 0130_pay_notification_preference_events.sql
--
-- Drops the notification preference change history. The current preferences are untouched.

DROP TRIGGER IF EXISTS "merchant_notification_preference_events_append_only_trg" ON "pay"."merchant_notification_preference_events";
DROP FUNCTION IF EXISTS "pay"."merchant_notification_preference_events_append_only"();
DROP TABLE IF EXISTS "pay"."merchant_notification_preference_events";
