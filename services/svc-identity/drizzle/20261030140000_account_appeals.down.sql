-- Reverses 20261030140000_account_appeals.sql.
DELETE FROM "identity"."mail_outbox" WHERE "purpose" = 'appeal-decided';
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed',
    'mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed', 'factor-changed',
    'support-recovery', 'support-recovery-used'
  ));
DROP TABLE IF EXISTS "identity"."account_appeal_events";
DROP TABLE IF EXISTS "identity"."account_appeals";
