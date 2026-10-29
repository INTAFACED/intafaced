-- Reverses 20261029060000_protocol_watch_preferences.sql: the Web3 lists are the account's own view records, so their rows
-- are dropped before the narrower check returns.
DELETE FROM "identity"."user_preferences" WHERE "namespace" IN ('protocol.token-watchlist', 'protocol.address-watches');
ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens'));
