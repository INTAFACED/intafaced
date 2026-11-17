-- svc-identity · J-support-public-05 #7: svc-support asks identity to mail a support chat to the account's own proved
-- address when the customer continues it by email (POST /internal/mail, purpose support-chat-email). Reversal: the
-- .down.sql of the same name.
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed',
    'mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed', 'factor-changed',
    'support-recovery', 'support-recovery-used', 'appeal-decided', 'support-chat-email'
  ));
