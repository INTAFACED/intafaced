-- Reverses 0068_home_tiles_preferences.sql: the Home layout is a view choice Home can rebuild from its shipped order, so
-- its rows are dropped before the narrower check returns.
DELETE FROM "identity"."user_preferences" WHERE "namespace" = 'home.tiles';
ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view'));
