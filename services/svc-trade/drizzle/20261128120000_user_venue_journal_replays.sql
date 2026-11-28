-- trade.user_venue_journal_replays · what the journal keeps to replay one of its closed perp trades
-- (src/venue/trade-journal.ts, J-charts-desk-20 #3). Reversal: 20261128120000_user_venue_journal_replays.down.sql
--
-- Beside each row of trade.user_venue_journal_trades: the venue's 1-minute candles of the trade's market from 10 bars
-- before the entry bar to the close, and where the trade's stop stood (the stop it opened with, then each later one, with
-- the time it was placed), as the venue reported them. So a trade the venue no longer returns replays on these bars,
-- named with the time they were stored. Never a balance: nothing is sent to the venue and the ledger posts nothing. A row
-- is written once, keyed as its trade is; a row kept with the trade's candles missing (`complete` false) is replaced once
-- when a later read has them.

CREATE TABLE IF NOT EXISTS trade.user_venue_journal_replays (
  venue_id text NOT NULL CONSTRAINT user_venue_journal_replays_venue_ck CHECK (length(btrim(venue_id)) > 0),
  owner text NOT NULL CONSTRAINT user_venue_journal_replays_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  -- '' for the main account.
  sub_account text NOT NULL DEFAULT '',
  trade_id text NOT NULL CONSTRAINT user_venue_journal_replays_trade_ck CHECK (length(btrim(trade_id)) > 0),
  complete boolean NOT NULL,
  -- The candles' interval ('1m') and the candles, oldest first, as decimal strings.
  bar_interval text NOT NULL,
  bars jsonb NOT NULL CONSTRAINT user_venue_journal_replays_bars_ck CHECK (jsonb_typeof(bars) = 'array'),
  -- [{ price, placedAt }], oldest first.
  stops jsonb NOT NULL CONSTRAINT user_venue_journal_replays_stops_ck CHECK (jsonb_typeof(stops) = 'array'),
  stored_at timestamptz NOT NULL,
  PRIMARY KEY (venue_id, owner, sub_account, trade_id)
);
