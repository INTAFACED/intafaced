-- svc-identity · sign-up by email with a mailed code before the first session (I-signin-sessions-18,
-- I-kyc-compliance-06). Reversal: 0066_signup_flows.down.sql.
--
-- A sign-up is an `auth_flows` row of kind `signup` plus one `signup_drafts` row: the account that will be
-- made when the code is entered. A new address and an address that already has an account do the same work
-- (one flow, one draft, one outbox row, one password hash); the known address gets a "someone tried to sign up
-- with your address" notice instead of a code, and its flow is `suppressed`, so no code can ever finish it.
-- No `users` row exists until the code is entered. The date of birth is checked and not stored.
-- `profiles.account_type` keeps the personal or business choice; accounts made before this are personal.
ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check" CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup'));

ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing'
  ));

CREATE TABLE IF NOT EXISTS "identity"."signup_drafts" (
  "flow_id"       uuid PRIMARY KEY REFERENCES "identity"."auth_flows"(id) ON DELETE CASCADE,
  "handle"        text NOT NULL,
  "email"         text NOT NULL,
  "password_hash" text NOT NULL,
  "country"       text NOT NULL CHECK ("country" ~ '^[A-Z]{2}$'),
  "account_type"  text NOT NULL CHECK ("account_type" IN ('individual', 'business')),
  "referrer_id"   uuid,
  "last_sent_at"  timestamptz NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "identity"."profiles"
  ADD COLUMN IF NOT EXISTS "account_type" text NOT NULL DEFAULT 'individual' CHECK ("account_type" IN ('individual', 'business'));
