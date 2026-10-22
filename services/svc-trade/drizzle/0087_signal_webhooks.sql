-- Trade signal webhooks (CB-bots-api-signal-01 PR 2, journey J-copy-bots-otc-20).
-- signal_webhooks: one row per customer webhook. Only the SHA-256 of the token is stored; the token itself is shown once by
-- `signals.webhook.create` and never written anywhere.
-- signal_alerts: the intent row for one alert, written BEFORE the order is placed. `alert_key` is
-- `signal.alert:<webhookId>:<alertId>` and is unique, so a repeated alert is one row and at most one order.
-- Reversal: 0087_signal_webhooks.down.sql (drops both tables, and with them the record of which alert placed which order;
-- orders already placed stay in trade.orders).

CREATE TABLE IF NOT EXISTS trade.signal_webhooks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  symbol text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 64),
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS signal_webhooks_user_idx ON trade.signal_webhooks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade.signal_alerts (
  id uuid PRIMARY KEY,
  alert_key text NOT NULL UNIQUE CHECK (alert_key LIKE 'signal.alert:%'),
  webhook_id uuid NOT NULL REFERENCES trade.signal_webhooks (id),
  user_id uuid NOT NULL,
  alert_id text NOT NULL,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  client_order_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pending', 'placed', 'refused')),
  order_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS signal_alerts_webhook_received_idx ON trade.signal_alerts (webhook_id, received_at DESC);
