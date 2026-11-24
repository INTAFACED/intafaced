-- trade.builder_mode_alerts (J-ops-console-28)
-- Reversal: 20261120161629_builder_mode_alerts.down.sql
--
-- A venue accrues builder fees only to a builder address in the mode it requires (Hyperliquid: standard). svc-trade reads
-- our builder address's mode at each venue (src/builder-fee/builder-mode.ts) and, while it is out of that mode, holds one
-- alert per venue and builder address, escalated to the owner's named contact (`contact`). The partial unique index keeps
-- one open alert per venue and address however many checks, retries or concurrent reads see it; a check that reads the
-- required mode again sets `cleared_at` and `cleared_mode`. Nothing here is money.

CREATE TABLE IF NOT EXISTS trade.builder_mode_alerts (
  id            bigserial PRIMARY KEY,
  venue_id      text NOT NULL,
  builder       text NOT NULL,
  mode_seen     text NOT NULL,
  required_mode text NOT NULL,
  contact       text NOT NULL,
  opened_at     timestamptz NOT NULL,
  cleared_at    timestamptz,
  cleared_mode  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_mode_alerts_cleared_ck CHECK ((cleared_at IS NULL) = (cleared_mode IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS builder_mode_alerts_open_uq
  ON trade.builder_mode_alerts (venue_id, builder) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS builder_mode_alerts_opened_idx ON trade.builder_mode_alerts (opened_at DESC, id DESC);
