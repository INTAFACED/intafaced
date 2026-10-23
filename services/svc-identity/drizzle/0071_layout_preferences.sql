-- Preferences gain two namespaces: trade.layouts (the account's saved chart layouts, C-workspace-02) and trade.chart-templates
-- (saved chart templates, C-embed-feed-ops-03), so both follow the account on every device.
-- Reversal: 0071_layout_preferences.down.sql

ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens', 'trade.layouts', 'trade.chart-templates'));
