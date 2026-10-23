-- Preferences gain two namespaces: trade.watchlists (the account's named watchlists, C-alerts-scan-05) and trade.screens (saved
-- screens, C-alerts-scan-07), so both follow the account on every device.
-- Reversal: 0073_watchlist_preferences.down.sql

ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens'));
