-- intafaced:destructive — reversal of 0067_pay_merchant_notifications.sql
--
-- Drops the in-app notification feed and preferences. Nothing was sent
-- externally, so nothing outside the portal is affected.

DROP TABLE IF EXISTS "pay"."merchant_notification_preferences";
DROP TABLE IF EXISTS "pay"."merchant_notifications";
