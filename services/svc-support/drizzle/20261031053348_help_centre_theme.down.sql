-- Reverse the help centre theme migration.
-- intafaced:destructive the owner's theme choice is dropped; the settings log keeps every change that set it.

ALTER TABLE "support"."help_centre" DROP CONSTRAINT IF EXISTS "help_centre_theme_ck";
ALTER TABLE "support"."help_centre" DROP COLUMN IF EXISTS "theme";
