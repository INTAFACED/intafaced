-- Reverses 20261024175120_mfa_resets.sql. Refuses while a reset waits: dropping the table would end that reset silently
-- and leave the person who started it waiting for nothing. Stop or finish them first; ended history is dropped.
-- intafaced:destructive deletes every mfa-reset mail row, sent or not, so the old CHECK can apply again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "identity"."mfa_resets" WHERE "state" = 'waiting') THEN
    RAISE EXCEPTION 'mfa_resets has waiting resets; refusing to drop it';
  END IF;
END $$;
DELETE FROM "identity"."mail_outbox" WHERE "purpose" IN ('mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed');
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed'
  ));
DROP TABLE IF EXISTS "identity"."mfa_resets";
