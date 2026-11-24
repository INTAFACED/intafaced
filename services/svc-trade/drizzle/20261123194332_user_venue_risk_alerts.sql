-- trade.user_venue_risk_alert_* · margin and liquidation-risk alerts on an isolated position on the person's own venue
-- account (J-derivatives-06 #6 #7; src/venue/risk-alerts.ts). Reversal: 20261123194332_user_venue_risk_alerts.down.sql
--
-- The venue holds the position and its margin; nothing here is a balance, nothing is sent to the venue, and the ledger
-- posts nothing. For each position the person turns alerts on and may set two risk levels: the margin (its margin and
-- unrealised result, as the venue reports them) at or below which a margin alert goes out, and the margin ratio (the
-- venue's maintenance requirement over that margin, in percent) at or above which a margin call goes out. The
-- liquidation alert needs no level of theirs: it goes out when the ratio reaches 100%, the venue's own maintenance
-- requirement. Each alert goes out once per crossing: a kind fires only while armed, and re-arms when the venue's figures
-- are back on the safe side. An alert row is written in the same transaction that disarms its kind, under its business
-- key `risk:<user>:<venue>:<owner>:<symbol>:<sequence>`, and published after; the consumer files it under that key, so a
-- crash between the two publishes it again and the person still gets one alert.

CREATE TABLE IF NOT EXISTS trade.user_venue_risk_alert_settings (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT user_venue_risk_alert_settings_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_risk_alert_settings_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  symbol text NOT NULL,
  enabled boolean NOT NULL,
  -- The person's margin level (the venue's collateral asset), or NULL when they set none.
  margin_level numeric(78, 18) CONSTRAINT user_venue_risk_alert_settings_margin_ck CHECK (margin_level IS NULL OR margin_level > 0),
  -- The person's margin-ratio level in percent, below the venue's own 100%, or NULL when they set none.
  ratio_level numeric(78, 18) CONSTRAINT user_venue_risk_alert_settings_ratio_ck CHECK (ratio_level IS NULL OR (ratio_level > 0 AND ratio_level < 100)),
  -- True while the figures were last read on the safe side of the kind's level: its next crossing sends one alert.
  armed_margin boolean NOT NULL,
  armed_margin_call boolean NOT NULL,
  armed_liquidation boolean NOT NULL,
  -- The next alert's sequence on this position: never reused, so a business key is never sent for two alerts.
  next_sequence integer NOT NULL CONSTRAINT user_venue_risk_alert_settings_seq_ck CHECK (next_sequence >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_risk_alert_settings_position_uq
  ON trade.user_venue_risk_alert_settings (user_id, venue_id, owner, symbol);
CREATE INDEX IF NOT EXISTS user_venue_risk_alert_settings_enabled_idx ON trade.user_venue_risk_alert_settings (enabled) WHERE enabled;

CREATE TABLE IF NOT EXISTS trade.user_venue_risk_alerts (
  setting_id uuid NOT NULL REFERENCES trade.user_venue_risk_alert_settings (id),
  sequence integer NOT NULL CONSTRAINT user_venue_risk_alerts_seq_ck CHECK (sequence >= 1),
  user_id text NOT NULL,
  venue_id text NOT NULL,
  owner text NOT NULL,
  symbol text NOT NULL,
  kind text NOT NULL CONSTRAINT user_venue_risk_alerts_kind_ck CHECK (kind IN ('margin', 'margin_call', 'liquidation')),
  alert_key text NOT NULL,
  asset text NOT NULL,
  -- The level crossed: the margin level for a margin alert, a ratio in percent for a margin call or the liquidation alert.
  level numeric(78, 18) NOT NULL,
  -- The venue's figures read at the crossing.
  margin_with_result numeric(78, 18) NOT NULL,
  maintenance numeric(78, 18),
  margin_ratio numeric(78, 18),
  -- What a margin call asks: the margin to add for the ratio to come back to its level. NULL for a margin alert.
  asked numeric(78, 18) CONSTRAINT user_venue_risk_alerts_asked_ck CHECK (asked IS NULL OR asked >= 0),
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (setting_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_risk_alerts_key_uq ON trade.user_venue_risk_alerts (alert_key);
CREATE INDEX IF NOT EXISTS user_venue_risk_alerts_owner_idx ON trade.user_venue_risk_alerts (user_id, venue_id, owner, created_at);
CREATE INDEX IF NOT EXISTS user_venue_risk_alerts_unpublished_idx ON trade.user_venue_risk_alerts (created_at) WHERE published_at IS NULL;

-- An alert is never deleted and what it said never changes; only its publication is recorded, once.
CREATE OR REPLACE FUNCTION trade.user_venue_risk_alerts_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_risk_alerts: an alert is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - 'published_at') OR OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'trade.user_venue_risk_alerts: only an unpublished alert changes, and only to record its publication.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_venue_risk_alerts_once_trg ON trade.user_venue_risk_alerts;
CREATE TRIGGER user_venue_risk_alerts_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_risk_alerts
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_risk_alerts_once();
