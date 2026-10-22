-- Reverses 0067_session_merchant_mfa.sql. Restricted sessions become ordinary sessions on their next refresh.
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "merchant_mfa";
