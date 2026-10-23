-- intafaced:destructive — reversal of 0000_tax_cost_basis.sql
--
-- Drops the customers' saved cost-basis choices (methods, day methods, lot picks). They are settings, not money: the lot
-- book falls back to the product default. The "tax" schema is left in place; the bootstrap owns it.

DROP TABLE IF EXISTS "tax"."lot_picks";
DROP TABLE IF EXISTS "tax"."method_days";
DROP TABLE IF EXISTS "tax"."method_choices";
