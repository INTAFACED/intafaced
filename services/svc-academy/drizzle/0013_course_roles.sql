-- svc-academy · course team roles, custom roles and role events (AC-roles-01)
-- Reversal: 0013_course_roles.down.sql
--
-- Built-in roles are code (roles/catalog.ts); custom roles are rows. An
-- assignment is scoped to one course id or to the whole academy ('*').
-- Revoking is a state (revoked_at), never a row delete.

CREATE TABLE IF NOT EXISTS "academy"."custom_roles" (
  "id"          text PRIMARY KEY,
  "label"       text NOT NULL,
  "permissions" text[] NOT NULL,
  "active"      boolean NOT NULL DEFAULT true,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custom_roles_id_chk" CHECK ("id" LIKE 'custom:%')
);

CREATE TABLE IF NOT EXISTS "academy"."role_assignments" (
  "course_scope" text NOT NULL,
  "account_id"   uuid NOT NULL,
  "role"         text NOT NULL,
  "activation"   integer NOT NULL DEFAULT 0,
  "revoked_at"   timestamptz,
  "assigned_by"  uuid NOT NULL,
  "assigned_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("course_scope", "account_id", "role")
);

CREATE INDEX IF NOT EXISTS "role_assignments_account_idx" ON "academy"."role_assignments" ("account_id");

CREATE TABLE IF NOT EXISTS "academy"."role_events" (
  "idempotency_key" text PRIMARY KEY,
  "action"          text NOT NULL,
  "course_scope"    text,
  "account_id"      uuid,
  "role"            text NOT NULL,
  "actor"           uuid NOT NULL,
  "approver"        text NOT NULL,
  "reason"          text NOT NULL,
  "at"              timestamptz NOT NULL DEFAULT now()
);
