-- J-more-catalogue-14 #6 (RC-more-catalogue-23). The kind of asset a launch issues: a plain token, a wrapped asset with
-- the asset that backs it, a synthetic with the oracle it tracks, or a structured asset with its leg terms, and its
-- compliance flags as labels (never limits). A launch written before this file records no kind (all null): nothing is
-- invented. Nothing here moves value or holds a balance.
-- Reversal: 20261107100000_launch_issuance_kind.down.sql

ALTER TABLE "token"."launch_events" ADD COLUMN IF NOT EXISTS "issuance_kind" text;
ALTER TABLE "token"."launch_events" ADD COLUMN IF NOT EXISTS "backing_asset" text;
ALTER TABLE "token"."launch_events" ADD COLUMN IF NOT EXISTS "oracle" text;
ALTER TABLE "token"."launch_events" ADD COLUMN IF NOT EXISTS "leg_terms" text;
ALTER TABLE "token"."launch_events" ADD COLUMN IF NOT EXISTS "issuance_flags" jsonb;

ALTER TABLE "token"."launch_events" DROP CONSTRAINT IF EXISTS "launch_events_issuance_ck";
ALTER TABLE "token"."launch_events" ADD CONSTRAINT "launch_events_issuance_ck" CHECK (
  ("issuance_kind" IS NULL AND "backing_asset" IS NULL AND "oracle" IS NULL AND "leg_terms" IS NULL AND "issuance_flags" IS NULL)
  OR ("issuance_kind" = 'token' AND "backing_asset" IS NULL AND "oracle" IS NULL AND "leg_terms" IS NULL)
  OR ("issuance_kind" = 'wrapped' AND "backing_asset" IS NOT NULL AND "oracle" IS NULL AND "leg_terms" IS NULL)
  OR ("issuance_kind" = 'synthetic' AND "oracle" IS NOT NULL AND "backing_asset" IS NULL AND "leg_terms" IS NULL)
  OR ("issuance_kind" = 'structured' AND "leg_terms" IS NOT NULL AND "backing_asset" IS NULL AND "oracle" IS NULL)
);
ALTER TABLE "token"."launch_events" DROP CONSTRAINT IF EXISTS "launch_events_issuance_flags_ck";
ALTER TABLE "token"."launch_events" ADD CONSTRAINT "launch_events_issuance_flags_ck" CHECK (
  "issuance_flags" IS NULL OR ("issuance_kind" IS NOT NULL AND jsonb_typeof("issuance_flags") = 'array' AND jsonb_array_length("issuance_flags") <= 8)
);
