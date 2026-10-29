-- Preferences gain two namespaces: protocol.token-watchlist (tokens the person watches by contract address, D-portfolio-wallet-07)
-- and protocol.address-watches (chain addresses watched with a tag and a private note, D-explorer-04), so both follow the
-- account on every device and only that account can read them.
-- Reversal: 20261029060000_protocol_watch_preferences.down.sql

ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens', 'protocol.token-watchlist', 'protocol.address-watches'));
