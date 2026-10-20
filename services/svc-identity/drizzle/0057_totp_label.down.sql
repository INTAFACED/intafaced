-- Reverses 0057_totp_label.sql. The authenticator keeps working; it loses its name.
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "totp_label";
