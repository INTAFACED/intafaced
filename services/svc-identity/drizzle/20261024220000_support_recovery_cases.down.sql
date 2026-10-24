-- Reverses 20261024220000_support_recovery_cases.sql.
-- intafaced:destructive deletes every support recovery mail row, sent or not, so the old CHECK can apply again, and drops
-- the cases (a link not yet used stops working).
DELETE FROM "identity"."mail_outbox" WHERE "purpose" IN ('support-recovery', 'support-recovery-used');
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed',
    'mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed', 'factor-changed'
  ));
DROP TABLE IF EXISTS "identity"."support_recovery_cases";
