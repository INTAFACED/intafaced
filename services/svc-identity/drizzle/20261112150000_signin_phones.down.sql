-- intafaced:destructive drops the phone numbers accounts sign in with; they sign in by handle or email as before.
DELETE FROM "identity"."auth_flows" WHERE "kind" = 'phone_link';
ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check"
  CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup', 'login_code', 'new_device', 'wallet_link', 'wallet_signin'));
DROP TABLE IF EXISTS "identity"."signin_phones";
