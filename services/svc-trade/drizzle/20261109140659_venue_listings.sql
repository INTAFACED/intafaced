-- trade.venue_listings, trade.venue_routed_limits, trade.venue_delisting_notices · J-cex-spot-16
-- Reversal: 20261109140659_venue_listings.down.sql
--
-- Our own record of which markets of an outside venue INTAFACED shows and routes customers' own orders to (the user-venue
-- door, src/venue/). The venue keeps its own state and limits; these tables keep only ours, each change a new version
-- written through a second operator's approval, the approval id its business key. Nothing here is a balance, a lock or an
-- order: a routing state or a limit change cancels nothing, touches no open venue order, and the ledger posts nothing.

-- One versioned line per (venue, symbol): the listing (opening time), our routing state and a scheduled delisting.
CREATE TABLE IF NOT EXISTS trade.venue_listings (
  venue_id text NOT NULL CONSTRAINT venue_listings_venue_ck CHECK (length(btrim(venue_id)) BETWEEN 1 AND 64),
  symbol text NOT NULL CONSTRAINT venue_listings_symbol_ck CHECK (length(btrim(symbol)) BETWEEN 1 AND 64),
  version integer NOT NULL CONSTRAINT venue_listings_version_ck CHECK (version >= 1),
  change text NOT NULL CONSTRAINT venue_listings_change_ck CHECK (change IN ('listing', 'routing', 'delisting')),
  opens_at timestamptz NOT NULL,
  delists_at timestamptz,
  routing text NOT NULL CONSTRAINT venue_listings_routing_ck CHECK (routing IN ('show', 'close_only', 'stop')),
  approval_id text NOT NULL CONSTRAINT venue_listings_approval_uq UNIQUE,
  proposer_id text NOT NULL,
  approver_id text NOT NULL,
  executor_id text NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (venue_id, symbol, version),
  CONSTRAINT venue_listings_delists_after_open_ck CHECK (delists_at IS NULL OR delists_at > opens_at),
  -- Two people, on every row in every environment (the stack's TEST seed records two distinct stack ids).
  CONSTRAINT venue_listings_two_people_ck CHECK (proposer_id <> approver_id)
);

-- Our largest order per (venue, symbol), versioned. Each version keeps the venue's own largest order it was checked
-- against when written: ours is never above it.
CREATE TABLE IF NOT EXISTS trade.venue_routed_limits (
  venue_id text NOT NULL CONSTRAINT venue_routed_limits_venue_ck CHECK (length(btrim(venue_id)) BETWEEN 1 AND 64),
  symbol text NOT NULL CONSTRAINT venue_routed_limits_symbol_ck CHECK (length(btrim(symbol)) BETWEEN 1 AND 64),
  version integer NOT NULL CONSTRAINT venue_routed_limits_version_ck CHECK (version >= 1),
  max_order_qty numeric(38, 18) NOT NULL CONSTRAINT venue_routed_limits_qty_ck CHECK (max_order_qty > 0),
  max_order_notional numeric(38, 18) NOT NULL CONSTRAINT venue_routed_limits_notional_ck CHECK (max_order_notional > 0),
  venue_max_order_qty numeric(38, 18) NOT NULL,
  venue_max_order_notional numeric(38, 18) NOT NULL,
  approval_id text NOT NULL CONSTRAINT venue_routed_limits_approval_uq UNIQUE,
  proposer_id text NOT NULL,
  approver_id text NOT NULL,
  executor_id text NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (venue_id, symbol, version),
  CONSTRAINT venue_routed_limits_not_above_venue_ck
    CHECK (max_order_qty <= venue_max_order_qty AND max_order_notional <= venue_max_order_notional),
  CONSTRAINT venue_routed_limits_two_people_ck CHECK (proposer_id <> approver_id)
);

-- The one dated customer notice a scheduled delisting sends, written with the listing version in one transaction and
-- published after commit; `published_at` is set once the bus took it, and a pending row is published again.
CREATE TABLE IF NOT EXISTS trade.venue_delisting_notices (
  notice_key text PRIMARY KEY CONSTRAINT venue_delisting_notices_key_ck CHECK (notice_key LIKE 'venue-delisting:%'),
  approval_id text NOT NULL CONSTRAINT venue_delisting_notices_approval_uq UNIQUE
    REFERENCES trade.venue_listings (approval_id),
  venue_id text NOT NULL,
  symbol text NOT NULL,
  delists_at timestamptz NOT NULL,
  scheduled_at timestamptz NOT NULL,
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS venue_delisting_notices_pending_idx
  ON trade.venue_delisting_notices (scheduled_at) WHERE published_at IS NULL;

-- Versions are append-only; a notice row changes only to record that it was published, once.
CREATE OR REPLACE FUNCTION trade.venue_listing_versions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: a version is never changed or deleted; write a new one.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS venue_listings_append_only_trg ON trade.venue_listings;
CREATE TRIGGER venue_listings_append_only_trg
  BEFORE UPDATE OR DELETE ON trade.venue_listings
  FOR EACH ROW EXECUTE FUNCTION trade.venue_listing_versions_append_only();
DROP TRIGGER IF EXISTS venue_routed_limits_append_only_trg ON trade.venue_routed_limits;
CREATE TRIGGER venue_routed_limits_append_only_trg
  BEFORE UPDATE OR DELETE ON trade.venue_routed_limits
  FOR EACH ROW EXECUTE FUNCTION trade.venue_listing_versions_append_only();

CREATE OR REPLACE FUNCTION trade.venue_delisting_notices_publish_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.venue_delisting_notices: a notice row is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.notice_key IS DISTINCT FROM OLD.notice_key OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.delists_at IS DISTINCT FROM OLD.delists_at OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
     OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'trade.venue_delisting_notices: only the first published time may be written.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS venue_delisting_notices_publish_once_trg ON trade.venue_delisting_notices;
CREATE TRIGGER venue_delisting_notices_publish_once_trg
  BEFORE UPDATE OR DELETE ON trade.venue_delisting_notices
  FOR EACH ROW EXECUTE FUNCTION trade.venue_delisting_notices_publish_once();
