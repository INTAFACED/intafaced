-- W1 MERCHANT CONTROL ROOM (1/5): risk tiers, merchant assignment, audit.
--
-- NO NUMBERS ARE SEEDED. Tier names, caps, reserve percentages and approval
-- thresholds belong to Nitro and Phantom and none are agreed: a fresh database
-- has zero tiers and zero assignments, and every money path that needs one
-- refuses with a typed error (pay.tier_unassigned, pay.caps_unconfigured ...).
--
-- `caps`, `approval_thresholds` and `founder_thresholds` are validated jsonb
-- arrays (contract shapes in packages/contracts/src/merchant-control.ts); money
-- inside them is a decimal STRING, never a JSON number.

CREATE TABLE IF NOT EXISTS "pay"."control_tiers" (
  "id"                   text PRIMARY KEY CONSTRAINT "control_tiers_id_slug" CHECK ("id" ~ '^[a-z][a-z0-9_-]{1,31}$'),
  "name"                 text NOT NULL CONSTRAINT "control_tiers_name_not_blank" CHECK (length(btrim("name")) > 0),
  "archetype"            text NOT NULL CONSTRAINT "control_tiers_archetype_known" CHECK ("archetype" IN ('psp', 'broker', 'gaming', 'standard')),
  "caps"                 jsonb NOT NULL CONSTRAINT "control_tiers_caps_array" CHECK (jsonb_typeof("caps") = 'array'),
  "reserve_bps"          integer CONSTRAINT "control_tiers_reserve_bps_range" CHECK ("reserve_bps" IS NULL OR ("reserve_bps" >= 0 AND "reserve_bps" <= 10000)),
  "reserve_hold_days"    integer CONSTRAINT "control_tiers_reserve_days_range" CHECK ("reserve_hold_days" IS NULL OR ("reserve_hold_days" >= 0 AND "reserve_hold_days" <= 365)),
  "approval_thresholds"  jsonb NOT NULL CONSTRAINT "control_tiers_approval_array" CHECK (jsonb_typeof("approval_thresholds") = 'array'),
  "founder_thresholds"   jsonb NOT NULL CONSTRAINT "control_tiers_founder_array" CHECK (jsonb_typeof("founder_thresholds") = 'array'),
  "approval_ttl_seconds" integer NOT NULL CONSTRAINT "control_tiers_ttl_positive" CHECK ("approval_ttl_seconds" > 0),
  "version"              bigint NOT NULL DEFAULT 1,
  "updated_by"           text NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  -- A reserve is both a percentage and a hold period, or neither.
  CONSTRAINT "control_tiers_reserve_pair" CHECK (("reserve_bps" IS NULL) = ("reserve_hold_days" IS NULL))
);

CREATE TABLE IF NOT EXISTS "pay"."control_merchant_profiles" (
  "merchant_id"      uuid PRIMARY KEY REFERENCES "pay"."merchants"("id"),
  "tier_id"          text REFERENCES "pay"."control_tiers"("id"),
  "archetype_id"     text CONSTRAINT "control_profiles_archetype_known" CHECK ("archetype_id" IS NULL OR "archetype_id" IN ('psp', 'broker', 'gaming', 'standard')),
  -- Per-merchant cap overrides, keyed like the tier's caps; null = none.
  "caps_override"    jsonb CONSTRAINT "control_profiles_caps_array" CHECK ("caps_override" IS NULL OR jsonb_typeof("caps_override") = 'array'),
  -- Null = inherit the tier. {"rollingReserveBps":null,"holdDays":null} = explicitly no reserve.
  "reserve_override" jsonb,
  "version"          bigint NOT NULL DEFAULT 0,
  "updated_by"       text,
  "updated_at"       timestamptz
);

CREATE INDEX IF NOT EXISTS "control_merchant_profiles_tier_idx" ON "pay"."control_merchant_profiles" ("tier_id");

-- Every attempt, including refused and conflicting ones, with the actor(s).
CREATE TABLE IF NOT EXISTS "pay"."control_audit" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"            bigserial NOT NULL,
  "scope"          text NOT NULL CONSTRAINT "control_audit_scope_known" CHECK ("scope" IN ('merchant', 'tier', 'pricing', 'approval')),
  "scope_id"       text NOT NULL,
  "merchant_id"    uuid,
  "kind"           text NOT NULL,
  "outcome"        text NOT NULL,
  "actor_id"       text NOT NULL CONSTRAINT "control_audit_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  "second_actor_id" text,
  "request_id"     uuid,
  "reason"         text NOT NULL CONSTRAINT "control_audit_reason_not_blank" CHECK (length(btrim("reason")) > 0),
  "before"         jsonb,
  "after"          jsonb,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "control_audit_seq_idx" ON "pay"."control_audit" ("seq");
CREATE INDEX IF NOT EXISTS "control_audit_merchant_idx" ON "pay"."control_audit" ("merchant_id", "seq" DESC);
CREATE INDEX IF NOT EXISTS "control_audit_scope_idx" ON "pay"."control_audit" ("scope", "scope_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."control_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted. Record a new row, do not edit the old one.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "control_audit_append_only_trg" ON "pay"."control_audit";
CREATE TRIGGER "control_audit_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."control_audit"
  FOR EACH ROW EXECUTE FUNCTION "pay"."control_append_only"();

-- Only row edits and deletes are blocked, on purpose: svc-pay's schema-wide test resets empty every table in
-- the schema, and emptying a table is table-owner only.
