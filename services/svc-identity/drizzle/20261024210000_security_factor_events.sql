-- svc-identity · a notice for each change to a sign-in factor (I-signin-sessions-08, J-identity-05 #6). Turning the
-- authenticator app on, off or replacing it, and adding or removing a passkey, queue in the same transaction as the
-- change: a "factor-changed" mail to the proved address, and one row here. A relay publishes each row as
-- identity.security_factor.updated after the commit (at least once; svc-notify writes the inbox notice). A rolled-back
-- change leaves neither. The row carries no secret: the account, what changed and when.
-- Reversal: 20261024210000_security_factor_events.down.sql
CREATE TABLE IF NOT EXISTS "identity"."security_factor_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  -- The business key: the account and the change's number for that account, counted under the users row lock.
  "notice_key"   text NOT NULL UNIQUE,
  "change"       text NOT NULL CHECK ("change" IN ('totp_added', 'totp_removed', 'totp_replaced', 'passkey_added', 'passkey_removed')),
  "changed_at"   timestamptz NOT NULL,
  "published_at" timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "security_factor_events_unpublished_idx"
  ON "identity"."security_factor_events" ("created_at") WHERE "published_at" IS NULL;
CREATE INDEX IF NOT EXISTS "security_factor_events_user_idx" ON "identity"."security_factor_events" ("user_id");

ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed',
    'mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed', 'factor-changed'
  ));
