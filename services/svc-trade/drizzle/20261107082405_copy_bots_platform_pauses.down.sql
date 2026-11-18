DROP TRIGGER IF EXISTS copy_bots_pauses_close_only_trg ON trade.copy_bots_pauses;
DROP FUNCTION IF EXISTS trade.copy_bots_pauses_close_only();
DROP TABLE IF EXISTS trade.copy_bots_pauses;
DROP TABLE IF EXISTS trade.copy_bots_pause_requests;
