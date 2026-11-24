-- Reverses 0001_basis_override_numeric.sql. price_per_unit and qty return to text and stay nullable.

ALTER TABLE tax.basis_overrides
  ALTER COLUMN price_per_unit TYPE text USING price_per_unit::text,
  ALTER COLUMN qty TYPE text USING qty::text;
