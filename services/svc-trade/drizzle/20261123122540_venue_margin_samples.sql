-- trade.venue_margin_samples · a venue account's margin as the venue reported it, each time it was read · J-derivatives-26 #8
-- Reversal: 20261123122540_venue_margin_samples.down.sql
--
-- The trading money is at the outside venue, which reports the account's margin now and keeps no history of it. Each
-- read of the account's margin summary through our door (src/venue/venue-margin-samples.ts) keeps what the venue said and
-- the venue's own as-of time, so a founder reads the account's ratio history, read-only, with its source and times. Only
-- a reading that differs from the account's latest kept one is kept. Every figure is the venue's; nothing here is a
-- balance of ours, and nothing moves.
CREATE TABLE IF NOT EXISTS trade.venue_margin_samples (
  venue_id            text NOT NULL,
  owner               text NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  sub_account         text NOT NULL DEFAULT '',
  as_of               timestamptz NOT NULL,
  asset               text NOT NULL,
  equity              numeric(38, 18) NOT NULL,
  maintenance_margin  numeric(38, 18) NOT NULL,
  margin_ratio        numeric(38, 18),
  cross_state         text CHECK (cross_state IS NULL OR cross_state IN ('healthy', 'margin_call')),
  PRIMARY KEY (venue_id, owner, sub_account, as_of)
);
