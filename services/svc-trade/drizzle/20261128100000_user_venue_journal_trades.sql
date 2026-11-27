-- trade.user_venue_journal_trades · the journal's own record of the person's closed perp trades on their own venue
-- account (src/venue/trade-journal.ts, J-portfolio-18). Reversal: 20261128100000_user_venue_journal_trades.down.sql
--
-- A copy of what the venue reported (its fills, funding, order history and 1-minute candles), worked into one row per
-- trade from flat to flat, so a trade stays whole after the venue stops returning its history. Never a balance: nothing
-- is sent to the venue and the ledger posts nothing. A row is written once, keyed by the trade's first fill; a row kept
-- with its candles missing (`complete` false) is replaced once when a later read has them.

CREATE TABLE IF NOT EXISTS trade.user_venue_journal_trades (
  venue_id text NOT NULL CONSTRAINT user_venue_journal_trades_venue_ck CHECK (length(btrim(venue_id)) > 0),
  owner text NOT NULL CONSTRAINT user_venue_journal_trades_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  -- '' for the main account.
  sub_account text NOT NULL DEFAULT '',
  trade_id text NOT NULL CONSTRAINT user_venue_journal_trades_trade_ck CHECK (length(btrim(trade_id)) > 0),
  symbol text NOT NULL,
  closed_at timestamptz NOT NULL,
  complete boolean NOT NULL,
  -- The trade's figures (@intafaced/contracts/trade-journal-procedures journalTradeFiguresSchema).
  trade jsonb NOT NULL CONSTRAINT user_venue_journal_trades_trade_json_ck CHECK (jsonb_typeof(trade) = 'object'),
  stored_at timestamptz NOT NULL,
  PRIMARY KEY (venue_id, owner, sub_account, trade_id)
);

CREATE INDEX IF NOT EXISTS user_venue_journal_trades_closed_idx
  ON trade.user_venue_journal_trades (venue_id, owner, sub_account, closed_at DESC);
