-- intafaced:destructive — reversal of the trusted-devices migration of the same name; drops trusted devices and waiting
-- new-device sign-ins. Sessions stay.
DELETE FROM "identity"."mail_outbox" WHERE "purpose" = 'new-device-code';
DELETE FROM "identity"."auth_flows" WHERE "kind" = 'new_device';
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'withdraw-address-approval'
  ));
ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check" CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup', 'login_code'));
DROP TABLE IF EXISTS "identity"."device_authorisations";
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "trusted_device_id";
DROP TABLE IF EXISTS "identity"."trusted_devices";
