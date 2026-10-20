-- Reversal of 0075_margin_adjust_sequence_unique.sql
-- Drops only an index; no table, column or row is lost.
DROP INDEX IF EXISTS "trade"."position_margin_adjustments_position_sequence_idx";
