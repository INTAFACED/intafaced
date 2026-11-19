-- 0000 is already recorded with price_per_unit and qty as text.
-- A recorded filename is skipped, and CREATE TABLE IF NOT EXISTS does not change a column.
-- Reversal: 0001_basis_override_numeric.down.sql
--
-- The cast refuses a non-decimal string. Null stays null. Both columns stay nullable.

ALTER TABLE tax.basis_overrides
  ALTER COLUMN price_per_unit TYPE numeric(38,18) USING price_per_unit::numeric(38,18),
  ALTER COLUMN qty TYPE numeric(38,18) USING qty::numeric(38,18);
