-- intafaced:destructive — reversal of 20261127213528_notify_telegram_chat_handle.sql
-- The linked chats keep their links; only the handle shown for each is dropped.

ALTER TABLE "notify"."telegram_links" DROP COLUMN IF EXISTS "chat_handle";
