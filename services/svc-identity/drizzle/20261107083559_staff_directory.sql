-- The staff directory and console-set approval policy rows (OPS-admin-access-03, OPS-change-control-01; J-ops-console-09).
--
-- approval_policy_rows: one row per governed action type that two founders set in the console. It stands in for the
-- deployment's owner row of that type (IDENTITY_ACTION_APPROVAL_POLICIES). "row" holds the four values exactly as the
-- founders approved them; identity reads them with the same reader as the deployment's setting, so a blank or unreadable
-- value is an unset row and the type refuses `action_approval.policy_unset`. "version" counts the console changes of the
-- type; a change is bound to the version its founders read. approval_policy_row_changes keeps every change, append-only.
--
-- staff_members: one row per person invited to the console. A person is invited by email and name with a second
-- founder's approval; "user_id" is the identity account, null until they set their own password at first connection.
-- staff_invite_tokens holds only the SHA-256 of the one-time first-connection token, its expiry and when it was used.
-- staff_change_audit keeps one row per privileged staff change (who asked, who approved, which approval was spent).
--
-- Reversal: 20261107083559_staff_directory.down.sql

CREATE TABLE IF NOT EXISTS "identity"."approval_policy_rows" (
  "action_type"  text PRIMARY KEY,
  "row"          jsonb NOT NULL,
  "version"      integer NOT NULL,
  "set_by"       uuid NOT NULL,
  "approved_by"  uuid NOT NULL,
  "approval_id"  text NOT NULL,
  "set_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "approval_policy_rows_version_ck" CHECK ("version" >= 1)
);

CREATE TABLE IF NOT EXISTS "identity"."approval_policy_row_changes" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "action_type"  text NOT NULL,
  "row"          jsonb NOT NULL,
  "version"      integer NOT NULL,
  "set_by"       uuid NOT NULL,
  "approved_by"  uuid NOT NULL,
  "approval_id"  text NOT NULL UNIQUE,
  "set_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "identity"."staff_members" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"            citext NOT NULL,
  "display_name"     text NOT NULL,
  "user_id"          uuid REFERENCES "identity"."users"("id"),
  "status"           text NOT NULL DEFAULT 'invited',
  "role_ids"         text[] NOT NULL DEFAULT '{}',
  "invited_by"       uuid NOT NULL,
  "approved_by"      uuid NOT NULL,
  "approval_id"      text NOT NULL UNIQUE,
  "request_id"       text NOT NULL UNIQUE,
  "invited_at"       timestamptz NOT NULL DEFAULT now(),
  "activated_at"     timestamptz,
  "disabled_at"      timestamptz,
  "last_sign_in_at"  timestamptz,
  "version"          integer NOT NULL DEFAULT 1,
  CONSTRAINT "staff_members_status_ck" CHECK ("status" IN ('invited', 'active', 'disabled')),
  CONSTRAINT "staff_members_active_ck" CHECK ("status" = 'invited' OR "user_id" IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "staff_members_email_uq" ON "identity"."staff_members" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "staff_members_user_uq" ON "identity"."staff_members" ("user_id") WHERE "user_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "identity"."staff_invite_tokens" (
  "token_hash"  text PRIMARY KEY,
  "staff_id"    uuid NOT NULL REFERENCES "identity"."staff_members"("id") ON DELETE CASCADE,
  "expires_at"  timestamptz NOT NULL,
  "used_at"     timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "staff_invite_tokens_staff_idx" ON "identity"."staff_invite_tokens" ("staff_id");

CREATE TABLE IF NOT EXISTS "identity"."staff_change_audit" (
  "audit_id"     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id"   text NOT NULL,
  "action"       text NOT NULL,
  "actor_id"     uuid NOT NULL,
  "approver_id"  uuid,
  "approval_id"  text,
  "staff_id"     uuid,
  "detail"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "staff_change_audit_staff_idx" ON "identity"."staff_change_audit" ("staff_id", "occurred_at");
