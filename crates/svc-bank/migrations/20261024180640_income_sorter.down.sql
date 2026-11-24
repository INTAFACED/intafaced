-- Reverses the income sorter. What already moved stays in the ledger under its own-space transfer keys.
DROP INDEX IF EXISTS "bank"."personal_transfers_to_posted_idx";
DROP TABLE IF EXISTS "bank"."income_sorter_run_legs";
DROP TABLE IF EXISTS "bank"."income_sorter_runs";
DROP TABLE IF EXISTS "bank"."income_sorter_legs";
DROP TABLE IF EXISTS "bank"."income_sorters";
