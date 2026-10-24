-- intafaced:destructive drops the retry columns; mail rows stay, a notice waiting to be retried is retried at once.
ALTER TABLE "identity"."mail_outbox" DROP COLUMN IF EXISTS "next_attempt_at";
ALTER TABLE "identity"."mail_outbox" DROP COLUMN IF EXISTS "failed_sends";
