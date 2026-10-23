-- svc-ledger · operator_access_log: also record operator lookups of one transaction (OPS-rules-monitoring-12, OPS-ledger-desk-01)
-- Reversal: 0026_operator_access_log_lookups.down.sql
--
-- The ledger desk's object lookup lets a founder open one booked transaction by its id or by its business key.
-- A business key names a customer's deposit, withdrawal or order, so each lookup writes one access row first,
-- exactly like an owner-balances read: if the row cannot be written the lookup is refused.
--
-- Additive only: the action check accepts two more values; every existing row still satisfies it, and an old pod
-- that writes only 'owner_balances.read' keeps working.

ALTER TABLE "ledger"."operator_access_log" DROP CONSTRAINT "operator_access_log_action_ck";
ALTER TABLE "ledger"."operator_access_log"
  ADD CONSTRAINT "operator_access_log_action_ck" CHECK (action IN ('owner_balances.read', 'transaction.read', 'trace.read'));
