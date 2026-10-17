-- intafaced:destructive — reversal of 0054_pay_control_changes.sql
--
-- Drops the dual-control change request log.

DROP TABLE IF EXISTS "pay"."control_changes";
