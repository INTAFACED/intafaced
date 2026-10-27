-- svc-ledger · operator_access_log: also record the ledger desk's transaction list and account address search (OPS-ledger-desk-01)
-- Reversal: 0028_operator_access_log_desk.down.sql
--
-- The desk lists booked transactions by asset and time, and finds accounts by address prefix. Both name customers'
-- movements and accounts, so each page writes one access row first, exactly like a lookup: if the row cannot be
-- written the read is refused.
--
-- Additive only: the action check accepts two more values; every existing row still satisfies it, and an old pod
-- that writes only the earlier actions keeps working.

ALTER TABLE "ledger"."operator_access_log" DROP CONSTRAINT "operator_access_log_action_ck";
ALTER TABLE "ledger"."operator_access_log"
  ADD CONSTRAINT "operator_access_log_action_ck"
  CHECK (action IN ('owner_balances.read', 'transaction.read', 'trace.read', 'transactions.list', 'accounts.search'));
