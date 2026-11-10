-- trade.signals · chart alert webhooks and their intents (CB-bots-api-signal-01, J-copy-bots-otc-20)
-- Reversal: 20261110153612_signal_webhooks.down.sql
--
-- A person creates a webhook for one venue market and the venue account they sign for. Its token is shown once and
-- stored only as a SHA-256 hash with a short prefix. Each accepted alert writes one intent row, keyed by the webhook and
-- the alert id, before the order is prepared; the order is prepared through svc-trade's user-venue door under the
-- alert's own business key (trade.user_venue_actions), and the person's wallet signs and sends it. The same alert id
-- again returns the stored result and prepares nothing. Nothing here holds money or a key: the venue is the record of
-- the person's balances and fills.

CREATE TABLE IF NOT EXISTS trade.signal_webhooks (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT signal_webhooks_user_ck CHECK (length(btrim(user_id)) > 0),
  client_request_id text NOT NULL,
  -- The venue's market symbol (BTC-USDC), as the door lists it.
  symbol text NOT NULL,
  -- The venue account an alert's order is prepared for; its owner wallet signs it.
  venue_owner text NOT NULL CONSTRAINT signal_webhooks_owner_ck CHECK (venue_owner ~ '^0x[0-9a-f]{40}$'),
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
  -- prepared: the door holds the order under action_key for the person's wallet to sign; nothing is sent before that.
  status text NOT NULL CONSTRAINT signal_intents_status_ck CHECK (status IN ('pending', 'prepared', 'refused', 'unknown')),
  action_key text,
  venue_client_order_id text,
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
