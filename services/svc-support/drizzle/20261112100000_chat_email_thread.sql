-- svc-support · J-support-public-05 #7: a chat the customer continued by email remembers when, so each later agent reply
-- is mailed into the same thread. Reversal: the .down.sql of the same name.
ALTER TABLE "support"."chat_sessions" ADD COLUMN IF NOT EXISTS "emailed_at" timestamptz;
