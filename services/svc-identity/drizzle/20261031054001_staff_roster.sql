-- svc-identity · the staff roster, custom staff roles and their assignments (OPS-admin-access-03 step 2a).
-- Every change is four-eyes: a founder files it, the other founder approves it, and identity spends that approval in
-- the transaction that writes here. `staff_change_audit` is append-only and keyed by the console's request id, so a
-- retry after a lost reply reads the stored answer instead of changing anything twice. `staff_events` is the outbox a
-- relay publishes as identity.staff.created|updated|deleted after the commit, at least once, under the catalog's
-- business keys. Built-in roles (founder, compliance, support, finance, developer) are not stored: their mappings are
-- the owner's and still unset, so nothing here may hold them.
-- Reversal: 20261031054001_staff_roster.down.sql
CREATE TABLE IF NOT EXISTS "identity"."staff_members" (
  "staff_id"        text PRIMARY KEY,
  -- Null only for an invite to an address with no identity account yet (accepting the invite is step 2b). Step 2a
  -- refuses such an invite, so every row it writes names an account.
  "user_id"         uuid UNIQUE REFERENCES "identity"."users" ("id") ON DELETE RESTRICT,
  "display_name"    text NOT NULL CHECK (char_length("display_name") BETWEEN 1 AND 120),
  "email"           citext NOT NULL UNIQUE,
  "status"          text NOT NULL CHECK ("status" IN ('invited', 'active', 'disabled')),
  "invited_at"      timestamptz NOT NULL,
  "invited_by"      text NOT NULL,
  "activated_at"    timestamptz,
  "disabled_at"     timestamptz,
  "last_sign_in_at" timestamptz,
  "version"         bigint NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "staff_members_status_stamps_ck" CHECK (
    ("status" = 'invited' AND "activated_at" IS NULL) OR "status" <> 'invited'
  ),
  CONSTRAINT "staff_members_disabled_stamp_ck" CHECK (("status" = 'disabled') = ("disabled_at" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "staff_members_status_idx" ON "identity"."staff_members" ("status", "staff_id");

-- Custom roles only. A permission is checked against the catalogue (`@intafaced/auth/staff-permissions`) on every
-- read, so a tampered row refuses `identity.staff_permission_invalid` rather than being skipped.
CREATE TABLE IF NOT EXISTS "identity"."staff_roles" (
  "role_id"    text PRIMARY KEY,
  "name"       text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 120),
  "allow"      text[] NOT NULL DEFAULT '{}',
  "deny"       text[] NOT NULL DEFAULT '{}',
  "version"    bigint NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "staff_roles_not_builtin_ck" CHECK (lower(btrim("name")) NOT IN ('founder', 'compliance', 'support', 'finance', 'developer'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "staff_roles_name_ci_idx" ON "identity"."staff_roles" (lower(btrim("name")));

CREATE TABLE IF NOT EXISTS "identity"."staff_role_assignments" (
  "staff_id"    text NOT NULL REFERENCES "identity"."staff_members" ("staff_id") ON DELETE CASCADE,
  "role_id"     text NOT NULL REFERENCES "identity"."staff_roles" ("role_id") ON DELETE RESTRICT,
  "assigned_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("staff_id", "role_id")
);
CREATE INDEX IF NOT EXISTS "staff_role_assignments_role_idx" ON "identity"."staff_role_assignments" ("role_id");

-- Append-only: one row per request id, refusals included. `fingerprint` is the request without its approval reference
-- hashed with the actor, so the same id with another body is told apart from a retry. `result` is the answer given.
CREATE TABLE IF NOT EXISTS "identity"."staff_change_audit" (
  "audit_id"    text PRIMARY KEY,
  "request_id"  text NOT NULL UNIQUE,
  "action"      text NOT NULL CHECK ("action" IN (
    'identity.staff.invite', 'identity.staff.disable', 'identity.staff.remove',
    'identity.roles.define', 'identity.roles.assign', 'identity.roles.unassign'
  )),
  "actor_id"    text NOT NULL,
  "approver_id" text,
  "approval_id" text,
  "fingerprint" text NOT NULL,
  "before"      jsonb,
  "after"       jsonb,
  "reason"      text,
  "result"      jsonb NOT NULL,
  "occurred_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "staff_change_audit_actor_idx" ON "identity"."staff_change_audit" ("actor_id", "occurred_at");

CREATE OR REPLACE FUNCTION "identity"."staff_change_audit_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff_change_audit is append-only';
END $$;
DROP TRIGGER IF EXISTS "staff_change_audit_append_only" ON "identity"."staff_change_audit";
CREATE TRIGGER "staff_change_audit_append_only" BEFORE UPDATE OR DELETE ON "identity"."staff_change_audit"
  FOR EACH ROW EXECUTE FUNCTION "identity"."staff_change_audit_append_only"();

-- The outbox. `event_key` is the catalog's business key, so a relay that publishes a row twice publishes one key.
CREATE TABLE IF NOT EXISTS "identity"."staff_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event"        text NOT NULL CHECK ("event" IN ('staffCreated', 'staffUpdated', 'staffDeleted')),
  "event_key"    text NOT NULL UNIQUE,
  "payload"      jsonb NOT NULL,
  "published_at" timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "staff_events_unpublished_idx"
  ON "identity"."staff_events" ("created_at") WHERE "published_at" IS NULL;
