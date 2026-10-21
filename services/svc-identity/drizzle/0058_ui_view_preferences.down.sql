-- Reverses 0058_ui_view_preferences.sql: the view record is a copy the device can rebuild, so its rows
-- are dropped before the narrower check returns.
DELETE FROM "identity"."user_preferences" WHERE "namespace" = 'ui.view';
ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display'));
