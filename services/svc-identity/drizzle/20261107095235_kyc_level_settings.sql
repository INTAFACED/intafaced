-- svc-identity · per-level requirements and review times, edited by compliance with a second person (I-kyc-compliance-05,
-- J-identity-20 #7). The owner's published values (IDENTITY_KYC_REQUIREMENTS_BY_LEVEL, IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL)
-- are the starting point. A change is proposed for one level and waits; a different person approves it, and only then does
-- it take effect, as one override row per level. A change may also put a level back to the owner's published values.
-- Reversal: the matching .down.sql
CREATE TABLE IF NOT EXISTS "identity"."kyc_level_settings" (
  "level"          text PRIMARY KEY CHECK ("level" IN ('basic', 'full', 'institutional')),
  -- Null: no requirements are published for the level.
  "requirements"   text[],
  -- Null: no review time is stated for the level.
  "review_minutes" integer CHECK ("review_minutes" IS NULL OR "review_minutes" BETWEEN 1 AND 525600),
  "change_id"      uuid NOT NULL,
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "identity"."kyc_level_setting_changes" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "level"          text NOT NULL CHECK ("level" IN ('basic', 'full', 'institutional')),
  -- True: put the level back to the owner's published values; the two value columns are then null.
  "restore"        boolean NOT NULL DEFAULT false,
  "requirements"   text[],
  "review_minutes" integer CHECK ("review_minutes" IS NULL OR "review_minutes" BETWEEN 1 AND 525600),
  "state"          text NOT NULL DEFAULT 'waiting' CHECK ("state" IN ('waiting', 'applied', 'withdrawn')),
  "proposed_by"    text NOT NULL,
  "proposed_at"    timestamptz NOT NULL DEFAULT now(),
  "decided_by"     text,
  "decided_at"     timestamptz
);
-- One waiting change per level at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "kyc_level_setting_changes_waiting_key"
  ON "identity"."kyc_level_setting_changes" ("level") WHERE "state" = 'waiting';
