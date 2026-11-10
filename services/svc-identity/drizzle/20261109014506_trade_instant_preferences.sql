-- Preferences gain trade.instant: the trading desk's instant placement setting (J-charts-desk-14 #6, C-trade-dom-02), on
-- only with the agreement the person accepted and the moment they accepted it, so it follows the account on every device.
-- Reversal: the matching .down.sql

ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens', 'protocol.token-watchlist', 'protocol.address-watches', 'trade.instant'));
