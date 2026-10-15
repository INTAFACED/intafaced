-- intafaced:destructive — reversal of 0053_pay_control_approvals.sql
--
-- Drops the payout approval trail (who requested, who approved).

DROP TABLE IF EXISTS "pay"."control_payout_approvals";
