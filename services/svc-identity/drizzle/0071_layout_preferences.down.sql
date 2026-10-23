-- Reverses 0071_layout_preferences.sql: the saved layouts and chart templates are the account's own view choices, so their rows
-- are dropped before the narrower check returns. The watchlist namespaces (0070) stay in the check.
DELETE FROM "identity"."user_preferences" WHERE "namespace" IN ('trade.layouts', 'trade.chart-templates');
ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens'));
