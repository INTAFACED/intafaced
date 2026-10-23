-- intafaced:destructive — reversal of 0001_tax_lot_basis.sql
--
-- Drops the prices customers entered for lots with no cost. They are inputs to an indicator, not money: those lots go back
-- to an unknown cost.

DROP TRIGGER IF EXISTS "lot_basis_append_only" ON "tax"."lot_basis";
DROP TABLE IF EXISTS "tax"."lot_basis";
DROP FUNCTION IF EXISTS "tax"."lot_basis_append_only"();
