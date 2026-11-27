-- intafaced:destructive — reversal of 20261127102114_notify_telegram_desk.sql
-- Telegram links, link codes, profit targets, margin crossings and the alert outbox are dropped; a person links again.

DROP TABLE IF EXISTS "notify"."telegram_alerts";
DROP TABLE IF EXISTS "notify"."telegram_marks";
DROP TABLE IF EXISTS "notify"."telegram_targets";
DROP TABLE IF EXISTS "notify"."telegram_links";
DROP TABLE IF EXISTS "notify"."telegram_link_codes";
