-- intafaced:destructive — reversal of 20261112150828_copy_pool_master_applications.sql
DROP TRIGGER IF EXISTS copy_pool_master_applications_append_only ON trade.copy_pool_master_applications;
DROP TABLE IF EXISTS trade.copy_pool_master_applications;
