-- intafaced:destructive drops linked wallets and the mailed-code choice; accounts sign in by password, passkey and
-- mailed code as before. An account whose only way in was a wallet can then use password reset by mail.
DELETE FROM "identity"."auth_flows" WHERE "kind" IN ('wallet_link', 'wallet_signin');
ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check" CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup', 'login_code', 'new_device'));
DROP TABLE IF EXISTS "identity"."wallet_identities";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "email_code_signin";
