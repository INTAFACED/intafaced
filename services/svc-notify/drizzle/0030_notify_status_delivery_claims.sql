-- svc-notify · status subscriber deliveries and imports (SP-status-04)
-- Reversal: 0030_notify_status_delivery_claims.down.sql
--
-- A delivery row is taken for a short lease before its send, so two fan-outs of one notice at once cannot both send it:
-- the one that does not hold the lease leaves the row alone. A subscriber added by a founder's import names its source
-- (NULL for one who subscribed on /status). Deliveries are read per event on the founders' desk.
ALTER TABLE notify.status_deliveries ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
ALTER TABLE notify.status_subscribers
  ADD COLUMN IF NOT EXISTS source text CHECK (source IS NULL OR source ~ '^[a-z0-9][a-z0-9-]{0,39}$');
CREATE INDEX IF NOT EXISTS status_deliveries_event_idx ON notify.status_deliveries (event);
CREATE INDEX IF NOT EXISTS status_subscribers_state_idx ON notify.status_subscribers (state, created_at);
