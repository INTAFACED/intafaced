-- intafaced:destructive — reversal of 20261118213506_chart_feed_controls.sql
-- Drops each market's chart feed control and its journal; every chart reads its primary source again. No money is held here.
DROP TABLE IF EXISTS "trade"."chart_feed_controls";
DROP TABLE IF EXISTS "trade"."chart_feed_state";
