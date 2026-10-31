-- svc-identity · a password change or reset is a sign-in factor change for the inbox (I-signin-sessions-08,
-- J-identity-03 #6): it queues a security_factor_events row, change 'password_changed', which the relay publishes for
-- svc-notify. The mail stays the password-changed notice. Widens the change CHECK by that one value.
-- Reversal: 20261030190000_security_factor_password_changed.down.sql
ALTER TABLE "identity"."security_factor_events" DROP CONSTRAINT IF EXISTS "security_factor_events_change_check";
ALTER TABLE "identity"."security_factor_events"
  ADD CONSTRAINT "security_factor_events_change_check"
  CHECK ("change" IN ('totp_added', 'totp_removed', 'totp_replaced', 'passkey_added', 'passkey_removed', 'password_changed'));
