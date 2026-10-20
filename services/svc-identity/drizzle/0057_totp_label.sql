-- Authenticator app lifecycle (I-signin-sessions-11): the owner's name for the authenticator app.
-- Empty until the owner names it. Replace keeps it; disable clears it.
-- Reversal: 0057_totp_label.down.sql

ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "totp_label" text;
