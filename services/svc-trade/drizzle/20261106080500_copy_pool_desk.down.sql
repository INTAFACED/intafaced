-- Reverses 20261106080500_copy_pool_desk.sql.
DROP TRIGGER IF EXISTS copy_pool_takeovers_append_only ON trade.copy_pool_takeovers;
DROP TABLE IF EXISTS trade.copy_pool_takeovers;
DROP TABLE IF EXISTS trade.copy_pool_whitelist;
DROP TABLE IF EXISTS trade.copy_pool_master_applications;
