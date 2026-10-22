-- Reverses 0070_sub_account_signin_switch.sql. Switch records and sign-in audit rows are dropped; sign-in is off again.
DROP TABLE IF EXISTS "identity"."sub_account_switches";
DROP TABLE IF EXISTS "identity"."sub_account_signin_audit";
ALTER TABLE "identity"."sub_accounts" DROP COLUMN IF EXISTS "signin_enabled";
