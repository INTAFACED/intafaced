-- svc-identity · support-assisted recovery (I-signin-sessions-24; J-identity-05 #5, J-identity-19). A person who cannot
-- sign in asks Support. An operator opens a case for the account (no link yet), a different operator approves it through
-- a four-eyes `identity.support_recovery_link` approval, and the opener then sends a one-time recovery link to the
-- account's own proved address. No operator ever sees the link: only its HMAC is stored here, and the plain token lives
-- in the mail outbox row until the relay claims it, as every mailed link does. The link works once, before its owner-set
-- lifetime ends; using it removes the authenticator app and its recovery codes and ends every session, in one
-- transaction, so the person signs in with the password and sets up a new app. One open case per account.
-- Reversal: 20261024220000_support_recovery_cases.down.sql
CREATE TABLE IF NOT EXISTS "identity"."support_recovery_cases" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "state"           text NOT NULL CHECK ("state" IN ('open', 'link_sent', 'used', 'cancelled', 'expired')),
  "reason"          text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "opened_by"       uuid NOT NULL,
  -- The opener's request id: the same id again answers the same case.
  "open_request_id" text NOT NULL CHECK (char_length("open_request_id") BETWEEN 1 AND 128),
  "approval_id"     text,
  "approved_by"     uuid,
  -- HMAC-SHA-256 of the mailed token under the flow key; set when the link is sent, never shown to anyone.
  "token_hash"      text UNIQUE CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$'),
  "link_sent_at"    timestamptz,
  "link_expires_at" timestamptz,
  "used_at"         timestamptz,
  "closed_by"       uuid,
  "closed_at"       timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("opened_by", "open_request_id"),
  CHECK (("state" = 'open') <= ("token_hash" IS NULL)),
  CHECK (("state" IN ('link_sent', 'used')) <= ("token_hash" IS NOT NULL AND "link_expires_at" IS NOT NULL AND "approved_by" IS NOT NULL)),
  CHECK (("state" = 'used') <= ("used_at" IS NOT NULL)),
  CHECK ("approved_by" IS NULL OR "approved_by" <> "opened_by")
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_recovery_cases_one_open_uq"
  ON "identity"."support_recovery_cases" ("user_id") WHERE "state" IN ('open', 'link_sent');
CREATE INDEX IF NOT EXISTS "support_recovery_cases_user_idx" ON "identity"."support_recovery_cases" ("user_id", "created_at" DESC);

ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed',
    'mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed', 'factor-changed',
    'support-recovery', 'support-recovery-used'
  ));
