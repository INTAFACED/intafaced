-- Reversal of 0033_customer_step_up.sql. Drops the ceremony and its audit.
-- Does not touch identity.action_approvals. No balances.

DROP TABLE IF EXISTS "identity"."step_up_audit";
DROP TABLE IF EXISTS "identity"."customer_step_ups";
