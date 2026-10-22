-- Organisation security policy (I-account-lifecycle-06): member second factor and idle sign-out for org calls.
-- No row = no policy (nothing required). Each change appends a history row in the same transaction.
-- Reversal: 0072_org_security_policy.down.sql

CREATE TABLE IF NOT EXISTS "identity"."org_security_policies" (
  "org_id" uuid PRIMARY KEY REFERENCES "identity"."organizations" ("id") ON DELETE CASCADE,
  "member_second_factor" text NOT NULL CHECK ("member_second_factor" IN ('any', 'passkey_only', 'totp_or_passkey')),
  "idle_sign_out_seconds" integer CHECK ("idle_sign_out_seconds" IS NULL OR "idle_sign_out_seconds" > 0),
  "version" integer NOT NULL DEFAULT 1,
  "updated_by" uuid NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS "identity"."org_security_policy_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "identity"."organizations" ("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "member_second_factor" text NOT NULL,
  "idle_sign_out_seconds" integer,
  "changed_by" uuid NOT NULL,
  "session_id" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("org_id", "version")
);

-- Last org call per (session, org). An org call after more than the idle setting since the last one ends the org
-- context for that session (refused until the member signs in again); the personal account is untouched.
CREATE TABLE IF NOT EXISTS "identity"."org_session_activity" (
  "session_id" uuid NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "identity"."organizations" ("id") ON DELETE CASCADE,
  "last_at" timestamptz NOT NULL,
  "ended_at" timestamptz,
  PRIMARY KEY ("session_id", "org_id")
);
