-- svc-notify · the linked Telegram chat's handle (J-charts-desk-21 #1)
-- Reversal: 20261127213528_notify_telegram_chat_handle.down.sql
--
-- The handle Telegram reported for the chat when the one-time code was sent (`@name`, else the chat's first name), so
-- account settings can show which chat is linked. Links made before this column have none and show none.

ALTER TABLE "notify"."telegram_links" ADD COLUMN IF NOT EXISTS "chat_handle" text;
