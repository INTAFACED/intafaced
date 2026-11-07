-- trade.signals · chart alert webhooks and their intents (CB-bots-api-signal-01, J-copy-bots-otc-20)
-- Reversal: 20261107095659_signal_webhooks.down.sql
--
-- A person creates a webhook for one market. Its token is shown once and stored only as a SHA-256 hash with a short
-- prefix. Each accepted alert writes one intent row, keyed by the webhook and the alert id, before any order call;
-- the same alert id again returns the stored result and places nothing. The order an intent places is an ordinary order
-- from the person's own balance, through the ordinary place path; nothing here holds money.

CREATE TABLE IF NOT EXISTS trade.signal_webhooks (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT signal_webhooks_user_ck CHECK (length(btrim(user_id)) > 0),
  client_request_id text NOT NULL,
  symbol text NOT NULL,
  market_id text NOT NULL,
  -- The creator's region as the edge resolved it at create; each alert's jurisdiction check reads it (OWNER 88).
  region text NOT NULL,
  token_hash text NOT NULL CONSTRAINT signal_webhooks_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text NOT NULL CONSTRAINT signal_webhooks_prefix_ck CHECK (length(token_prefix) = 6),
  place_grant jsonb NOT NULL,
  grant_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CONSTRAINT signal_webhooks_state_ck CHECK (state IN ('active', 'paused', 'ended')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_webhooks_request_idx ON trade.signal_webhooks (user_id, client_request_id);
CREATE INDEX IF NOT EXISTS signal_webhooks_user_idx ON trade.signal_webhooks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade.signal_intents (
  id uuid PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES trade.signal_webhooks (id),
  alert_id text NOT NULL CONSTRAINT signal_intents_alert_ck CHECK (length(alert_id) BETWEEN 1 AND 120),
  -- One alert plans one or two actions (a reversal plans a close and an open); each is its own row.
  action text NOT NULL CONSTRAINT signal_intents_action_ck CHECK (action IN ('open', 'close')),
  intent_key text NOT NULL,
  side text NOT NULL CONSTRAINT signal_intents_side_ck CHECK (side IN ('buy', 'sell')),
  sizing jsonb NOT NULL,
  status text NOT NULL CONSTRAINT signal_intents_status_ck CHECK (status IN ('pending', 'placed', 'refused', 'unknown')),
  order_id text,
  code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_intents_key_idx ON trade.signal_intents (intent_key);
CREATE INDEX IF NOT EXISTS signal_intents_webhook_idx ON trade.signal_intents (webhook_id, created_at);

-- The reply an alert got, kept so the same alert id again returns it exactly.
CREATE TABLE IF NOT EXISTS trade.signal_alert_results (
  webhook_id uuid NOT NULL REFERENCES trade.signal_webhooks (id),
  alert_id text NOT NULL,
  status integer NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (webhook_id, alert_id)
);
