-- intafaced:destructive — reversal of 0102_statement_exports.sql
-- Drops the statement jobs and their files. No money moved through them; the orders, fills and ledger lines stay.
DROP TABLE IF EXISTS "trade"."statement_exports";
