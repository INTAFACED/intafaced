DROP TRIGGER IF EXISTS notice_components_known ON notify.notices;
DROP FUNCTION IF EXISTS notify.notice_components_known();
ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_components_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_components_ck"
  CHECK ("components" <@ ARRAY['api', 'webhooks', 'console']::text[]);
DROP TABLE IF EXISTS notify.status_readings;
DROP TABLE IF EXISTS notify.status_page_log;
DROP TABLE IF EXISTS notify.status_page;
DROP FUNCTION IF EXISTS notify.status_append_only();
