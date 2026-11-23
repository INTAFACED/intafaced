-- intafaced:destructive — reversal of 0023_entries_immutable.sql
--
-- Removes the database-level tamper protection on the journal: after this,
-- UPDATE / DELETE / TRUNCATE on ledger_entries and ledger_tx, and unbalanced
-- transactions, are no longer refused by the database. No rows are lost by
-- running it, and it does not need an empty book (it restores the behaviour
-- of 0022-and-earlier). The 0016 key/meta trigger and the 0017/0018 claim
-- table are untouched.

DROP TRIGGER IF EXISTS "ledger_entries_tx_must_balance" ON "ledger"."ledger_entries";
DROP TRIGGER IF EXISTS "ledger_entries_no_truncate" ON "ledger"."ledger_entries";
DROP TRIGGER IF EXISTS "ledger_tx_no_truncate" ON "ledger"."ledger_tx";
DROP TRIGGER IF EXISTS "ledger_entries_immutable" ON "ledger"."ledger_entries";
DROP TRIGGER IF EXISTS "ledger_tx_immutable" ON "ledger"."ledger_tx";
DROP FUNCTION IF EXISTS "ledger"."ledger_tx_must_balance"();
DROP FUNCTION IF EXISTS "ledger"."ledger_journal_no_truncate"();
DROP FUNCTION IF EXISTS "ledger"."ledger_journal_immutable"();
