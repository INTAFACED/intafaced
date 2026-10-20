-- trade.futures · one margin adjustment per (position, ledger sequence)
-- Reversal: 0075_margin_adjust_sequence_unique.down.sql
--
-- `sequence` is the ledger post key for a live futuresMarginAdd / futuresMarginRelease. Two rows with the same
-- (position_id, sequence) would post two different adjustments under one key, and the ledger would treat the
-- second as a replay of the first. Only the pending row was unique; completed rows were not.

CREATE UNIQUE INDEX IF NOT EXISTS "position_margin_adjustments_position_sequence_idx"
  ON "trade"."position_margin_adjustments" ("position_id", "sequence");
