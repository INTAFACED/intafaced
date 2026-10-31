-- svc-support · help centre theme (SP-help-centre-03)
-- Reversal: the matching .down.sql
--
-- The owner's choice of which product palette the public help centre opens in: system, light or dark. NULL until the
-- owner sets it; nothing is seeded and a blank theme is never read as a built-in choice. Rows of the settings log
-- written before this column carry no theme in their before/after records; the service reads those as blank.

ALTER TABLE "support"."help_centre" ADD COLUMN IF NOT EXISTS "theme" text;
ALTER TABLE "support"."help_centre" DROP CONSTRAINT IF EXISTS "help_centre_theme_ck";
ALTER TABLE "support"."help_centre"
  ADD CONSTRAINT "help_centre_theme_ck" CHECK ("theme" IS NULL OR "theme" IN ('system', 'light', 'dark'));
