-- intafaced:destructive — reversal of 20261025003000_recovery_claims.sql. Dropping these tables loses which claim
-- swept which account. The ledger keeps every posted sweep under its bank.transfer.recovery key.
DROP TABLE IF EXISTS "bank"."recovery_sweeps";
DROP TABLE IF EXISTS "bank"."recovery_claims";
