-- trade · VIP trial passes granted as a campaign reward (CM-vip-tiers-01, J-campaigns-14 #2 to #4)
-- Reversal: 20261116030000_tier_passes.down.sql
--
-- svc-campaigns grants a trial pass from a `trial_pass` campaign: a fee tier for a span of seconds, keyed
-- `trial-pass:<campaignId>:<userId>`, one per campaign and person. The tier is charged like a VIP trial: an order placed
-- while the pass is in force keeps the higher of its snapshot tier and the pass's tier. A later pass replaces the one in
-- force: the earlier ends at the grant (`replaced`). A pass that runs its span ends at its end time (`expired`). Either
-- way it ends once: `ended_at` is written once and never changed. It moves no money.

CREATE TABLE IF NOT EXISTS "trade"."tier_passes" (
  "id"               uuid PRIMARY KEY,
  "pass_key"         text NOT NULL,
  "user_id"          uuid NOT NULL,
  "campaign_id"      text NOT NULL CONSTRAINT "tier_passes_campaign_ck" CHECK (length(btrim("campaign_id")) > 0),
  "tier_id"          text NOT NULL CONSTRAINT "tier_passes_tier_ck" CHECK (length(btrim("tier_id")) > 0 AND "tier_id" <> 'regular'),
  "starts_at"        timestamptz NOT NULL,
  "ends_at"          timestamptz NOT NULL,
  "schedule_version" text NOT NULL,
  "granted_by"       text NOT NULL CONSTRAINT "tier_passes_granted_by_ck" CHECK (length(btrim("granted_by")) > 0),
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "ended_at"         timestamptz,
  "end_reason"       text CONSTRAINT "tier_passes_end_reason_ck" CHECK ("end_reason" IN ('expired', 'replaced')),
  "replaced_by"      text,
  CONSTRAINT "tier_passes_key_ck" CHECK ("pass_key" = 'trial-pass:' || "campaign_id" || ':' || "user_id"::text),
  CONSTRAINT "tier_passes_span_ck" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "tier_passes_end_ck" CHECK (
    ("ended_at" IS NULL AND "end_reason" IS NULL AND "replaced_by" IS NULL)
    OR ("end_reason" = 'expired' AND "ended_at" = "ends_at" AND "replaced_by" IS NULL)
    OR ("end_reason" = 'replaced' AND "ended_at" IS NOT NULL AND "ended_at" < "ends_at" AND "replaced_by" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "tier_passes_key_idx" ON "trade"."tier_passes" ("pass_key");
CREATE INDEX IF NOT EXISTS "tier_passes_user_idx" ON "trade"."tier_passes" ("user_id", "starts_at" DESC);
CREATE INDEX IF NOT EXISTS "tier_passes_open_idx" ON "trade"."tier_passes" ("ends_at") WHERE "ended_at" IS NULL;

-- A pass is never deleted, and only its end is ever written, once.
CREATE OR REPLACE FUNCTION "trade"."tier_passes_end_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.tier_passes: a pass is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."ended_at" IS NOT NULL
     OR (NEW."id", NEW."pass_key", NEW."user_id", NEW."campaign_id", NEW."tier_id", NEW."starts_at", NEW."ends_at",
         NEW."schedule_version", NEW."granted_by", NEW."created_at")
        IS DISTINCT FROM
        (OLD."id", OLD."pass_key", OLD."user_id", OLD."campaign_id", OLD."tier_id", OLD."starts_at", OLD."ends_at",
         OLD."schedule_version", OLD."granted_by", OLD."created_at") THEN
    RAISE EXCEPTION 'trade.tier_passes: only an open pass''s end is written, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "tier_passes_end_once_trg" ON "trade"."tier_passes";
CREATE TRIGGER "tier_passes_end_once_trg"
  BEFORE UPDATE OR DELETE ON "trade"."tier_passes"
  FOR EACH ROW EXECUTE FUNCTION "trade"."tier_passes_end_once"();
