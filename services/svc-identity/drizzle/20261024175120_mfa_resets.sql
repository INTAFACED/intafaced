-- svc-identity · the locked-out second-factor reset (I-signin-sessions-12, J-identity-05 #2/#3). A person who lost the
-- authenticator app and every recovery code proves the password, then a code mailed to the proved address, then waits
-- the owner's IDENTITY_MFA_RESET_WAIT_SECONDS. While it waits every contact on file is told, and any signed-in session
-- of the account can stop it. Once the wait has passed, the next password sign-in removes the authenticator app and its
-- recovery codes and ends every session, in one transaction. One open reset per account.
-- Its mails ride the mail outbox: the code, and the started, stopped and completed notices.
-- Reversal: 20261024175120_mfa_resets.down.sql
CREATE TABLE IF NOT EXISTS "identity"."mfa_resets" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "state"            text NOT NULL CHECK ("state" IN ('code_sent', 'locked', 'waiting', 'cancelled', 'completed', 'expired')),
  -- SHA-256 of the mailed code (HMAC with the flow key); null once the code has been used.
  -- When the authenticator app it was started for was set up: a reset removes only that app, never one set up later.
  "factor_enrolled_at" timestamptz,
  "code_hash"        text CHECK ("code_hash" IS NULL OR "code_hash" ~ '^[0-9a-f]{64}$'),
  "code_expires_at"  timestamptz NOT NULL,
  "attempts"         integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "wait_seconds"     integer CHECK ("wait_seconds" IS NULL OR "wait_seconds" >= 0),
  "waiting_since"    timestamptz,
  "completes_at"     timestamptz,
  "cancelled_at"     timestamptz,
  "cancelled_by_session" uuid,
  "completed_at"     timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  CHECK (("state" = 'waiting') <= ("completes_at" IS NOT NULL AND "waiting_since" IS NOT NULL)),
  CHECK ("completes_at" IS NULL OR "completes_at" >= "waiting_since")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mfa_resets_one_open_uq"
  ON "identity"."mfa_resets" ("user_id") WHERE "state" IN ('code_sent', 'waiting');
CREATE INDEX IF NOT EXISTS "mfa_resets_user_idx" ON "identity"."mfa_resets" ("user_id", "created_at" DESC);

ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed',
    'mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed'
  ));
