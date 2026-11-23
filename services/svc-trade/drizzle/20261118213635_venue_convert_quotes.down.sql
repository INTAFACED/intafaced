-- Reverses 20261118213635_venue_convert_quotes.sql. Destructive: every stored venue convert quote is lost, so an accept of
-- a quote made before it refuses `trade.convert_quote_unknown`. Orders already accepted stay in trade.user_venue_actions.
DROP TABLE IF EXISTS trade.venue_convert_quotes;
