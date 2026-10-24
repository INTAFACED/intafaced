-- Reverses 20261024210000_security_factor_events.sql.
-- intafaced:destructive deletes every factor-changed mail row, sent or not, so the old CHECK can apply again, and drops
-- the factor change rows (their inbox notices already written stay in svc-notify).
DELETE FROM "identity"."mail_outbox" WHERE "purpose" = 'factor-changed';
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed',
    'mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed'
  ));
DROP TABLE IF EXISTS "identity"."security_factor_events";
