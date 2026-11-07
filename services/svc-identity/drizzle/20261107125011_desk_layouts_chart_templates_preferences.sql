-- Preferences gain two namespaces: trade.desk.layouts (the account's saved desk layouts, C-workspace-02) and charts.templates
-- (the account's chart templates, C-embed-feed-ops-03), so both follow the person to every device and only that account
-- can read them.
-- Reversal: 20261107125011_desk_layouts_chart_templates_preferences.down.sql

ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens', 'protocol.token-watchlist', 'protocol.address-watches', 'trade.desk.layouts', 'charts.templates'));
