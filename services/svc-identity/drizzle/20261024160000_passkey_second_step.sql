-- svc-identity · a passkey as the second step after the password (I-signin-sessions-10). `passkey_second_step` is the
-- account's own choice to be asked for a passkey after its password; off for every existing account, which signs in
-- exactly as before. The `second-step` challenge kind is the single-use passkey challenge issued once the password
-- verified. Which actions a passkey answers for lives on the credential in `webauthn_creds` (`purposes`).
-- Reversal: the .down.sql of the same name.
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "passkey_second_step" boolean NOT NULL DEFAULT false;
ALTER TABLE "identity"."webauthn_challenges" DROP CONSTRAINT IF EXISTS "webauthn_challenges_kind_ck";
ALTER TABLE "identity"."webauthn_challenges"
  ADD CONSTRAINT "webauthn_challenges_kind_ck" CHECK ("kind" IN ('registration', 'authentication', 'step-up', 'second-step'));
