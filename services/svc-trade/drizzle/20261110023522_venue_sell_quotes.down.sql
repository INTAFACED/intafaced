-- Reverses 20261110023522_venue_sell_quotes.sql. Destructive: every stored venue sell quote is lost, and finance's read of
-- them shows none. Run only on a database whose rows may go.
DROP TABLE IF EXISTS trade.venue_sell_quotes;
