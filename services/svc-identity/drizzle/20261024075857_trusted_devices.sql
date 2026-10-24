-- svc-identity · trusted devices and new-device sign-in authorisation (I-signin-sessions-07). Reversal: the .down.sql of
-- the same name.
--
-- A device is a random key held in a long-lived HttpOnly cookie; only its SHA-256 is stored. Sign-up trusts the first
-- device. A sign-in whose factors all passed, from a device with no live row for that account (or with no cookie), is a
-- new device: it waits on an `auth_flows` row of kind `new_device` plus one `device_authorisations` row holding what the
-- waiting sign-in proved. The person approves it with the code mailed to the account (`new-device-code`) or from a
-- session that is already signed in on a trusted device; approval writes the trusted row and lets the waiting browser,
-- which alone holds the flow's secret, open its session once. Removing a device ends the sessions signed in on it.
CREATE TABLE IF NOT EXISTS "identity"."trusted_devices" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "device_key_hash" text NOT NULL CHECK ("device_key_hash" ~ '^[0-9a-f]{64}$'),
  "label"           text NOT NULL CHECK (char_length("label") BETWEEN 1 AND 120),
  "first_seen_at"   timestamptz NOT NULL DEFAULT now(),
  "last_seen_at"    timestamptz NOT NULL DEFAULT now(),
  "trusted_until"   timestamptz,
  "removed_at"      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "trusted_devices_user_key_live_idx"
  ON "identity"."trusted_devices" ("user_id", "device_key_hash") WHERE "removed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "trusted_devices_user_idx" ON "identity"."trusted_devices" ("user_id");

ALTER TABLE "identity"."sessions" ADD COLUMN IF NOT EXISTS "trusted_device_id" uuid
  REFERENCES "identity"."trusted_devices"(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "identity"."device_authorisations" (
  "flow_id"        uuid PRIMARY KEY REFERENCES "identity"."auth_flows"(id) ON DELETE CASCADE,
  "user_id"        uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "secret_hash"    text NOT NULL CHECK ("secret_hash" ~ '^[0-9a-f]{64}$'),
  "mfa"            boolean NOT NULL,
  "label"          text NOT NULL CHECK (char_length("label") BETWEEN 1 AND 120),
  "approved_at"    timestamptz,
  "approved_by_session" uuid,
  "completed_at"   timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "device_authorisations_user_idx" ON "identity"."device_authorisations" ("user_id", "created_at" DESC);

ALTER TABLE "identity"."auth_flows" DROP CONSTRAINT IF EXISTS "auth_flows_kind_check";
ALTER TABLE "identity"."auth_flows"
  ADD CONSTRAINT "auth_flows_kind_check" CHECK ("kind" IN ('password_reset', 'handle_recovery', 'signup', 'login_code', 'new_device'));

ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'withdraw-address-approval', 'new-device-code'
  ));
