-- intafaced:destructive — reversal of 20261123121455_venue_statement_liquidation_rows.sql
ALTER TABLE trade.venue_statement_exports DROP COLUMN IF EXISTS liquidation_rows;
