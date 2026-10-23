-- Preferences gain a fourth namespace, home.tiles (the order of a person's Home tiles and the ones they hid), so the
-- Home layout follows the account (HM-widgets-01).
-- Reversal: 0068_home_tiles_preferences.down.sql

ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles'));
