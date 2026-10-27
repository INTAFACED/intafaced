-- Drops the direct debit mandates, collections and refund requests. A collected debit keeps its ledger entry (key
-- `bank.transfer.rail:dd:<mandate>:<collection>:0`); only the bank's record of which mandate it came from is lost.
DROP TABLE IF EXISTS "bank"."dd_refund_requests";
DROP TABLE IF EXISTS "bank"."dd_collections";
DROP TABLE IF EXISTS "bank"."dd_mandates";
