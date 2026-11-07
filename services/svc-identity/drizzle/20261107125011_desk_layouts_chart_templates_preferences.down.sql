-- Reverses 20261107125011_desk_layouts_chart_templates_preferences.sql: saved desk layouts and chart templates are the
-- account's own view records, so their rows are dropped before the narrower check returns.
DELETE FROM "identity"."user_preferences" WHERE "namespace" IN ('trade.desk.layouts', 'charts.templates');
ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens', 'protocol.token-watchlist', 'protocol.address-watches'));
