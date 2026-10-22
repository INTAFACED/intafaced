-- Reverses 0066_signup_flows.sql. Open sign-ups are dropped; accounts already made stay.
DROP TABLE IF EXISTS "identity"."signup_drafts";
DELETE FROM "identity"."mail_outbox" WHERE "purpose" IN ('signup-code', 'signup-existing');
DELETE FROM "identity"."auth_flows" WHERE "kind" = 'signup';
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account'
  ));
ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check" CHECK ("kind" IN ('password_reset', 'handle_recovery'));
