-- intafaced:destructive — reversal of 20261121060548_venue_convert_cash_leg.sql. The TEST cash partner's record of every cash leg and
-- every cash quote's partner figure are lost; a cash quote not yet accepted then reads as a plain venue quote.
DROP TABLE IF EXISTS trade.test_cash_partner_legs;
ALTER TABLE trade.venue_convert_quotes DROP CONSTRAINT IF EXISTS venue_convert_quotes_cash_ck;
ALTER TABLE trade.venue_convert_quotes
  DROP COLUMN IF EXISTS cash_stable_amount,
  DROP COLUMN IF EXISTS cash_fee,
  DROP COLUMN IF EXISTS cash_rate,
  DROP COLUMN IF EXISTS cash_stable;
