-- svc-ledger · one operator reversal per original transaction, held by the database (OPS-ledger-desk-02)
-- Reversal: 20261123173000_operator_reversal_once.down.sql
--
-- The `operatorReverse` door books an operator's corrective reversal under `ops:reversal:<originalTxId>:<n>`, with the
-- original's id in `meta.reverses`. The key alone cannot stop a second reversal: a second approval carries a second
-- ordinal, so a second key. This index is the rule: two reversals of one original can never both commit, however the
-- two posts race. The door answers the loser `ledger.reversal_already_reversed`, naming the first.
--
-- Scoped to the reversal's own module and reason, so a `reverses` key some other post's meta happens to carry can
-- never take an original's one slot. No row changes; on a book with no reversal it builds an empty index.
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_tx_one_operator_reversal_idx"
  ON "ledger"."ledger_tx" (("meta"->>'reverses'))
  WHERE "module" = 'ops' AND "reason" = 'operator.reversal';
