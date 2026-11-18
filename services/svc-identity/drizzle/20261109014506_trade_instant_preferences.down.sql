-- Reverses the trade.instant migration: the rows are dropped before the narrower check returns, so every desk reads
-- instant placement as off again.
DELETE FROM "identity"."user_preferences" WHERE "namespace" = 'trade.instant';
ALTER TABLE "identity"."user_preferences" DROP CONSTRAINT IF EXISTS "user_preferences_namespace_check";
ALTER TABLE "identity"."user_preferences"
  ADD CONSTRAINT "user_preferences_namespace_check" CHECK ("namespace" IN ('trade.views', 'account.display', 'ui.view', 'home.tiles', 'trade.watchlists', 'trade.screens', 'protocol.token-watchlist', 'protocol.address-watches'));
