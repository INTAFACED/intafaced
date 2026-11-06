-- svc-identity · a new device approved and signed in is a security notice for the inbox and the proved address
-- (I-signin-sessions-08, J-identity-06 #7): completing an approved new-device sign-in queues a security_factor_events
-- row, change 'new_device', and its factor-changed mail. Widens the change CHECK by that one value.
-- Reversal: the matching .down.sql
ALTER TABLE "identity"."security_factor_events" DROP CONSTRAINT IF EXISTS "security_factor_events_change_check";
ALTER TABLE "identity"."security_factor_events"
  ADD CONSTRAINT "security_factor_events_change_check"
  CHECK ("change" IN ('totp_added', 'totp_removed', 'totp_replaced', 'passkey_added', 'passkey_removed', 'password_changed', 'new_device'));
