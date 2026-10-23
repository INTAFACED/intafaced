-- svc-notify · status subscriptions (SP-status-04)
-- Reversal: 0028_notify_status_subscriptions.down.sql
--
-- A subscriber is one email address: unconfirmed until the signed link is opened, then active, until it leaves by the
-- link in a message. Two owner values join the status page row, NULL until a founder sets them: the proof-of-work
-- strength and the subscribe requests allowed per address per hour (blank refuses subscribing). A used challenge is kept
-- so it cannot be replayed. A delivery row is keyed `<event>:<subscriber>:<channel>` and written before the send.
ALTER TABLE notify.status_page
  ADD COLUMN IF NOT EXISTS challenge_bits integer CHECK (challenge_bits IS NULL OR challenge_bits BETWEEN 1 AND 32),
  ADD COLUMN IF NOT EXISTS subscribe_rate_per_hour integer CHECK (subscribe_rate_per_hour IS NULL OR subscribe_rate_per_hour BETWEEN 1 AND 1000);

CREATE TABLE IF NOT EXISTS notify.status_subscribers (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 3 AND 254),
  state text NOT NULL CHECK (state IN ('unconfirmed', 'active', 'unsubscribed')),
  component_ids jsonb CHECK (component_ids IS NULL OR jsonb_typeof(component_ids) = 'array'),
  webhook_url text CHECK (webhook_url IS NULL OR (webhook_url LIKE 'https://%' AND char_length(webhook_url) <= 500)),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS notify.status_subscribe_requests (
  email text NOT NULL,
  requested_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS status_subscribe_requests_idx ON notify.status_subscribe_requests (email, requested_at);
CREATE TABLE IF NOT EXISTS notify.status_challenges_used (
  token_hash text PRIMARY KEY,
  used_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS notify.status_deliveries (
  key text PRIMARY KEY,
  subscriber_id uuid NOT NULL REFERENCES notify.status_subscribers (id),
  event text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'webhook')),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'failed', 'refused')),
  refusal_code text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS status_deliveries_subscriber_idx ON notify.status_deliveries (subscriber_id);
