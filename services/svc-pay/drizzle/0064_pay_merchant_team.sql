-- W15 merchant operations: team members, their roles, and the audit trail behind them.
--
-- The merchant OWNER is not a row here: it is `pay.merchants.user_id`, so a team
-- can never be left without one and the owner cannot be demoted by a role edit.
-- A row here is a SECOND person who acts for a merchant. A user belongs to at
-- most one merchant team at a time (partial unique index), the same way a
-- sovereign account owns at most one merchant.
--
-- The role vocabulary is checked here and mirrored in src/merchant-ops/roles.ts.

CREATE TABLE IF NOT EXISTS "pay"."merchant_team_members" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"    uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "user_id"        text NOT NULL CONSTRAINT "merchant_team_members_user_not_blank" CHECK (length(btrim("user_id")) > 0),
  "role"           text NOT NULL CONSTRAINT "merchant_team_members_role_ck" CHECK ("role" IN ('admin', 'finance', 'developer', 'viewer')),
  "status"         text NOT NULL DEFAULT 'invited' CONSTRAINT "merchant_team_members_status_ck" CHECK ("status" IN ('invited', 'active', 'removed')),
  "label"          text,
  "invited_by"     text NOT NULL CONSTRAINT "merchant_team_members_invited_by_not_blank" CHECK (length(btrim("invited_by")) > 0),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "activated_at"   timestamptz,
  "removed_at"     timestamptz
);

-- One row per (merchant, person): re-inviting a removed person reuses the row.
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_team_members_merchant_user_idx"
  ON "pay"."merchant_team_members" ("merchant_id", "user_id");

-- One ACTIVE team per person. Invitations may be outstanding for several.
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_team_members_one_active_idx"
  ON "pay"."merchant_team_members" ("user_id") WHERE "status" = 'active';

CREATE INDEX IF NOT EXISTS "merchant_team_members_merchant_idx"
  ON "pay"."merchant_team_members" ("merchant_id", "created_at", "id");

-- Append-only: who invited, accepted, re-roled or removed whom, and when.
CREATE TABLE IF NOT EXISTS "pay"."merchant_team_events" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"            bigserial NOT NULL,
  "merchant_id"    uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "member_user_id" text NOT NULL,
  "action"         text NOT NULL CONSTRAINT "merchant_team_events_action_ck" CHECK ("action" IN ('invited', 'accepted', 'role_changed', 'removed', 'declined')),
  "from_role"      text,
  "to_role"        text,
  "actor_id"       text NOT NULL CONSTRAINT "merchant_team_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_team_events_seq_idx" ON "pay"."merchant_team_events" ("seq");
CREATE INDEX IF NOT EXISTS "merchant_team_events_merchant_idx" ON "pay"."merchant_team_events" ("merchant_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."merchant_team_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.merchant_team_events is append-only: % is not permitted. Record a new event instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "merchant_team_events_append_only_trg" ON "pay"."merchant_team_events";
CREATE TRIGGER "merchant_team_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."merchant_team_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_team_events_append_only"();
