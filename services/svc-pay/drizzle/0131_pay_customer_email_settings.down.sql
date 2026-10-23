-- intafaced:destructive — reversal of 0131_pay_customer_email_settings.sql
--
-- Drops the merchant's customer-email switches. No address was stored.

DROP TABLE IF EXISTS "pay"."merchant_customer_email_settings";
