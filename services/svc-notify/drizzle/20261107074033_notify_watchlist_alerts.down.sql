-- Reversal of 20261107074033_notify_watchlist_alerts.sql. The price alerts the rules created stay, each managed on its own; no market
-- added to a list later is picked up any more.
DROP TABLE IF EXISTS "notify"."watchlist_alerts";
