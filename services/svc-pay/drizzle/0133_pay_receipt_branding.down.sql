-- intafaced:destructive — reversal of 0133_pay_receipt_branding.sql
--
-- Drops receipt template versions, the issue pin, status-email switches and the
-- unused status-email queue. No address was stored.

DROP TABLE IF EXISTS "pay"."payment_status_email_queue";
DROP TABLE IF EXISTS "pay"."receipt_issues";
DROP TABLE IF EXISTS "pay"."receipt_template_requests";
DROP TABLE IF EXISTS "pay"."merchant_status_email_settings";
DROP TABLE IF EXISTS "pay"."receipt_template_versions";
DROP FUNCTION IF EXISTS "pay"."receipt_branding_append_only"();
