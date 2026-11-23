-- intafaced:destructive — reversal of 20261124090000_ledger_reversals.sql
--
-- Lossy by nature: svc-ops' record of every reversal asked for, who approved it and what the ledger answered is dropped.
-- The reversing transactions themselves stay in the ledger, so run this only where no reversal was ever asked for.
DROP TRIGGER IF EXISTS ledger_reversals_guard ON ops.ledger_reversals;
DROP FUNCTION IF EXISTS ops.ledger_reversals_guard();
DROP TABLE IF EXISTS ops.ledger_reversals;
