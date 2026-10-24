-- Reverses the login-codes migration of the same name. Open code sign-ins are dropped; sessions they opened stay.
DELETE FROM "identity"."mail_outbox" WHERE "purpose" IN ('login-code', 'login-no-account');
DELETE FROM "identity"."auth_flows" WHERE "kind" = 'login_code';
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing'
  ));
ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check" CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup'));
