-- intafaced:destructive — reversal of 20261121123642_venue_convert_cash_legs.sql
ALTER TABLE trade.venue_convert_quotes DROP CONSTRAINT IF EXISTS venue_convert_quotes_cash_ck;
ALTER TABLE trade.venue_convert_quotes
  DROP COLUMN IF EXISTS cash_asset,
  DROP COLUMN IF EXISTS cash_coin,
  DROP COLUMN IF EXISTS cash_rate,
  DROP COLUMN IF EXISTS cash_coin_spend,
  DROP COLUMN IF EXISTS cash_label,
  DROP COLUMN IF EXISTS cash_test,
  DROP COLUMN IF EXISTS cash_accepted_at;
