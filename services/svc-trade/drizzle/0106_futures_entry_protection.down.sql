-- intafaced:destructive — reversal of 0106_futures_entry_protection.sql
-- Drops what each opening order asked for. Legs already armed are ordinary take-profit and stop-loss rows and stay;
-- a request still waiting for its order to fill is lost, and its owner sets the protection on the position instead.
DROP TABLE IF EXISTS "trade"."futures_entry_protection";
