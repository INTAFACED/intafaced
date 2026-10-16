-- intafaced:destructive — reversal of 0077_pay_conversion.sql
--
-- Drops sandbox conversion quotes and orders. Ledger postings are not in these
-- tables; dropping the rows does not move a balance. A venue order that was
-- already sent is no longer recorded here.

DROP TABLE IF EXISTS "pay"."conversion_late_fill_acks";
DROP TABLE IF EXISTS "pay"."conversion_audit";
DROP TABLE IF EXISTS "pay"."conversion_resolve_proposals";
DROP TABLE IF EXISTS "pay"."conversion_orders";
DROP TABLE IF EXISTS "pay"."conversion_quotes";
