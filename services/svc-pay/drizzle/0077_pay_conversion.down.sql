-- intafaced:destructive — reversal of 0077_pay_conversion.sql
--
-- Drops sandbox conversion quotes and orders. Ledger postings are not in these
-- tables; dropping the rows does not move a balance. A venue order that was
-- already sent is no longer recorded here.

DROP TABLE IF EXISTS "pay"."conversion_orders";
DROP TABLE IF EXISTS "pay"."conversion_quotes";
