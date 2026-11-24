-- Reverses 20261112100000_chat_email_thread.sql.
ALTER TABLE "support"."chat_sessions" DROP COLUMN IF EXISTS "emailed_at";
