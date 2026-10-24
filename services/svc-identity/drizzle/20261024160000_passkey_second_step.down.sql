-- intafaced:destructive drops the passkey-second-step choice and any waiting second-step challenge; accounts sign in
-- with the password and their authenticator as before. Passkey purposes stay on the credentials, unread.
DELETE FROM "identity"."webauthn_challenges" WHERE "kind" = 'second-step';
ALTER TABLE "identity"."webauthn_challenges" DROP CONSTRAINT IF EXISTS "webauthn_challenges_kind_ck";
ALTER TABLE "identity"."webauthn_challenges"
  ADD CONSTRAINT "webauthn_challenges_kind_ck" CHECK ("kind" IN ('registration', 'authentication', 'step-up'));
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "passkey_second_step";
