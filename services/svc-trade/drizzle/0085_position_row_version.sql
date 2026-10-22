-- Real row version for trade.positions: bumped by trigger on EVERY UPDATE, whoever writes the row
-- (margin adjust, funding tick, liquidation rung, ADL, close). Keys trade.position.updated events, so
-- each write gets a new idempotency key and a retry of the same DB state keeps the same one.
-- Reversal: 0085_position_row_version.down.sql
ALTER TABLE trade.positions ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION trade.positions_bump_row_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS positions_bump_row_version_trg ON trade.positions;
CREATE TRIGGER positions_bump_row_version_trg
  BEFORE UPDATE ON trade.positions
  FOR EACH ROW EXECUTE FUNCTION trade.positions_bump_row_version();
