-- intafaced:destructive — reversal of 20261106081141_pay_refund_control.sql
--
-- Drops the refund approval rules and their change history, refund requests and bulk refund rows. No ledger row moves: a queued request posted
-- nothing, and every refund that ran is a `refunded` payment event and a ledger post that stay. The `voided` payment
-- status cannot be removed from a Postgres enum safely; it is left in place, unused by older code.
DROP TABLE IF EXISTS "pay"."refund_batch_rows";
DROP TABLE IF EXISTS "pay"."refund_requests";
DROP TABLE IF EXISTS "pay"."refund_approval_rule_changes";
DROP TABLE IF EXISTS "pay"."refund_approval_rules";
