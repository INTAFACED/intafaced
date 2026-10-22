DROP TRIGGER IF EXISTS positions_bump_row_version_trg ON trade.positions;
DROP FUNCTION IF EXISTS trade.positions_bump_row_version();
ALTER TABLE trade.positions DROP COLUMN IF EXISTS row_version;
