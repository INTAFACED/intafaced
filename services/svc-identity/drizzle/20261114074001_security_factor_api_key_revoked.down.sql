-- Reverses the api_key_revoked widening. Those rows stay (each one's number is part of the account's notice-key count);
-- the narrower CHECK goes back NOT VALID, so it holds for new rows only.
ALTER TABLE "identity"."security_factor_events" DROP CONSTRAINT IF EXISTS "security_factor_events_change_check";
ALTER TABLE "identity"."security_factor_events"
  ADD CONSTRAINT "security_factor_events_change_check"
  CHECK ("change" IN ('totp_added', 'totp_removed', 'totp_replaced', 'passkey_added', 'passkey_removed', 'password_changed', 'new_device')) NOT VALID;
