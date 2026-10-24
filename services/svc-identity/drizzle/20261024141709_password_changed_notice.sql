-- svc-identity · the "your password was changed" notice (I-signin-sessions-08) rides the mail outbox as purpose
-- `password-changed`: no code, no link, keyed by account and new hash. Reversal: the .down.sql of the same name.
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed'
  ));
