-- Reverses 20261030190000_security_factor_password_changed.sql. The password_changed rows stay: each one's number is
-- part of the account's notice-key count, so deleting them would make a later change reuse a key and be dropped. The
-- narrow CHECK goes back NOT VALID, so it holds for new rows only.
ALTER TABLE "identity"."security_factor_events" DROP CONSTRAINT IF EXISTS "security_factor_events_change_check";
ALTER TABLE "identity"."security_factor_events"
  ADD CONSTRAINT "security_factor_events_change_check"
  CHECK ("change" IN ('totp_added', 'totp_removed', 'totp_replaced', 'passkey_added', 'passkey_removed')) NOT VALID;
