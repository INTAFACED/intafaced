-- intafaced:destructive drops the service-mail columns and their unsent rows (the caller asks again).
-- Reverses the service-mail migration of the same name. Service mails not yet sent are dropped; the caller's link
-- stays valid on its side and a new request mails it again.
DELETE FROM "identity"."mail_outbox" WHERE "flow_id" IS NULL OR "purpose" = 'withdraw-address-approval';
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account'
  ));
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_owner_check";
DROP INDEX IF EXISTS "identity"."mail_outbox_dedupe_key_uq";
ALTER TABLE "identity"."mail_outbox" DROP COLUMN IF EXISTS "detail";
ALTER TABLE "identity"."mail_outbox" DROP COLUMN IF EXISTS "body_hash";
ALTER TABLE "identity"."mail_outbox" DROP COLUMN IF EXISTS "dedupe_key";
ALTER TABLE "identity"."mail_outbox" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "identity"."mail_outbox" ALTER COLUMN "flow_id" SET NOT NULL;
