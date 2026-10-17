-- Reverse 0060_copy_disclosure_acceptances.sql
DROP TRIGGER IF EXISTS copy_disclosure_acceptances_append_only ON trade.copy_disclosure_acceptances;
DROP TABLE IF EXISTS trade.copy_disclosure_acceptances;
DROP FUNCTION IF EXISTS trade.copy_disclosure_append_only();
