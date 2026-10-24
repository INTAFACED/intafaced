-- Reverses 0074_watchlist_preferences.sql: the watchlists and saved screens are the account's own view choices, so their rows are
-- dropped before the narrower check returns.
DELETE FROM "identity"."user_preferences" WHERE "namespace" IN ('trade.watchlists', 'trade.screens');
ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles'));
