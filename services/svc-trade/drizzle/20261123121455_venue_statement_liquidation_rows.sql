-- trade.venue_statement_exports: how many liquidation parts the file lists · J-derivatives-26 #7
-- Reversal: 20261123121455_venue_statement_liquidation_rows.down.sql
--
-- A venue statement lists each part of each liquidation the venue reports on the account, with its fee and the venue's
-- ids (src/venue/venue-statements.ts). A job finished before this column has none: it was built before liquidations were
-- listed, so its count stays null and the app shows no liquidation count for it.
ALTER TABLE trade.venue_statement_exports
  ADD COLUMN IF NOT EXISTS liquidation_rows integer CHECK (liquidation_rows IS NULL OR liquidation_rows >= 0);
