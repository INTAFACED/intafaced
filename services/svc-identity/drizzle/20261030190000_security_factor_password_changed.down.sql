-- Reverses 20261030190000_security_factor_password_changed.sql. Password-change rows go with it (published or not:
-- the inbox rows svc-notify wrote stay).
DELETE FROM "identity"."security_factor_events" WHERE "change" = 'password_changed';
ALTER TABLE "identity"."security_factor_events" DROP CONSTRAINT IF EXISTS "security_factor_events_change_check";
ALTER TABLE "identity"."security_factor_events"
  ADD CONSTRAINT "security_factor_events_change_check"
  CHECK ("change" IN ('totp_added', 'totp_removed', 'totp_replaced', 'passkey_added', 'passkey_removed'));
