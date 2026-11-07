-- svc-identity · an API key revoked because a leaked copy was reported (DV-keys-05, J-developer-07 #6) is a security
-- notice for the holder's inbox: the report queues one security_factor_events row, change 'api_key_revoked', in the
-- transaction that revokes the key. Widens the change CHECK by that one value.
-- Reversal: the matching .down.sql
ALTER TABLE "identity"."security_factor_events" DROP CONSTRAINT IF EXISTS "security_factor_events_change_check";
ALTER TABLE "identity"."security_factor_events"
  ADD CONSTRAINT "security_factor_events_change_check"
  CHECK ("change" IN ('totp_added', 'totp_removed', 'totp_replaced', 'passkey_added', 'passkey_removed', 'password_changed', 'new_device', 'api_key_revoked'));
