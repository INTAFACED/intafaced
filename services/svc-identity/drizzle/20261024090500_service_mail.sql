-- intafaced:destructive flow_id drops NOT NULL; the new owner check keeps every row tied to a flow or to a service key and account.
-- svc-identity · mail another service asks identity to send to a customer (POST /internal/mail). Reversal: the
-- .down.sql of the same name.
--
-- Such a mail has no sign-in flow behind it, so `flow_id` becomes optional. The caller's business key (`dedupe_key`)
-- is unique, so a retried request finds the first mail instead of sending a second; `body_hash` lets a retry with a
-- different body be refused. `user_id` names the account the mail is about, and `detail` is the plain line it shows.
ALTER TABLE "identity"."mail_outbox" ALTER COLUMN "flow_id" DROP NOT NULL;
ALTER TABLE "identity"."mail_outbox" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "identity"."mail_outbox" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
ALTER TABLE "identity"."mail_outbox" ADD COLUMN IF NOT EXISTS "body_hash" text;
ALTER TABLE "identity"."mail_outbox" ADD COLUMN IF NOT EXISTS "detail" text;
CREATE UNIQUE INDEX IF NOT EXISTS "mail_outbox_dedupe_key_uq" ON "identity"."mail_outbox" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;

-- A mail is either part of a flow or a service mail with its key and account, never neither.
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_owner_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_owner_check" CHECK (
    "flow_id" IS NOT NULL OR ("dedupe_key" IS NOT NULL AND "user_id" IS NOT NULL AND "body_hash" IS NOT NULL)
  );

-- The list also names new-device-code (trusted devices, 20261024075857) so either migration applied last keeps both.
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval'
  ));
