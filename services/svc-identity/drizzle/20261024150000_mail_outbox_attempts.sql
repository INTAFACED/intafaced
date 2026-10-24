-- svc-identity · retries of a password-changed notice whose send failed. It carries no secret, so it goes back to
-- pending, but no sooner than `next_attempt_at` (a doubling wait) and only until `failed_sends` reaches the relay's cap:
-- a notice that always fails can neither take every relay's places from code mails nor be retried for ever.
-- Reversal: the .down.sql of the same name.
ALTER TABLE "identity"."mail_outbox" ADD COLUMN IF NOT EXISTS "failed_sends" integer NOT NULL DEFAULT 0;
ALTER TABLE "identity"."mail_outbox" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz;
