-- D-instruments-08 (J-derivatives-02 #8): a futures market's dynamic price range. The operator's limits row gains
-- the widest band, the premium past which the band widens and the cadence it is worked out at; any blank keeps the
-- owner's static band in force. Each working of the band is kept: the band in force now, and every change to it.
-- Reversal: 0104_operator_price_range.down.sql
ALTER TABLE trade.operator_risk_limits
  ADD COLUMN IF NOT EXISTS price_range_max text,
  ADD COLUMN IF NOT EXISTS price_range_trigger text,
  ADD COLUMN IF NOT EXISTS price_range_cadence_seconds text;

CREATE TABLE IF NOT EXISTS trade.futures_price_band_current (
  market_id uuid PRIMARY KEY,
  band text NOT NULL,
  static_band text NOT NULL,
  premium text,
  mark text,
  book_mid text,
  reason text NOT NULL,
  risk_version bigint NOT NULL,
  checked_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS trade.futures_price_band_changes (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL,
  band text NOT NULL,
  previous_band text,
  static_band text NOT NULL,
  premium text,
  mark text,
  book_mid text,
  reason text NOT NULL,
  risk_version bigint NOT NULL,
  changed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS futures_price_band_changes_market_at ON trade.futures_price_band_changes (market_id, changed_at DESC);
