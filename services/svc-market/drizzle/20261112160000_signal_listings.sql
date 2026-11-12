-- market.signal_listings and market.signal_payments (CB-bots-api-signal-04, J-copy-bots-otc-21 #1 #2)
-- Reversal: 20261112160000_signal_listings.down.sql
--
-- A signal listing is a provider's signal that a person may buy access to, and then run a signal bot from (svc-trade).
-- Access is bought once. The payment is the card partner's to hold: the person pays by card through the partner, and
-- our ledger records only our revenue (chargeEarn) and the partner's settlement of it into our reserve there
-- (chargeCollect). INTAFACED keeps no prepaid balance. A blank listing price refuses the purchase.
--
-- One row per buyer and listing, written before the partner is asked, under the business key
-- `signal-payment:<listingId>:<buyerId>`: a retry finds the row and carries on from its state, never charges twice.

CREATE TABLE IF NOT EXISTS market.signal_listings (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL CONSTRAINT signal_listings_provider_ck CHECK (length(btrim(provider_id)) > 0),
  client_listing_id text NOT NULL CONSTRAINT signal_listings_client_ck CHECK (length(client_listing_id) BETWEEN 1 AND 120),
  title text NOT NULL CONSTRAINT signal_listings_title_ck CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description text NOT NULL,
  asset_id text NOT NULL CONSTRAINT signal_listings_asset_ck CHECK (asset_id ~ '^[A-Z0-9]{2,12}$'),
  -- The provider's price for access, a decimal string. NULL: not set, and every purchase refuses.
  price text CONSTRAINT signal_listings_price_ck CHECK (price IS NULL OR price ~ '^[0-9]+(\.[0-9]+)?$'),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_listings_client_idx ON market.signal_listings (provider_id, client_listing_id);
CREATE INDEX IF NOT EXISTS signal_listings_created_idx ON market.signal_listings (created_at, id);

CREATE TABLE IF NOT EXISTS market.signal_payments (
  id uuid PRIMARY KEY,
  listing_id uuid NOT NULL REFERENCES market.signal_listings (id),
  buyer_id text NOT NULL CONSTRAINT signal_payments_buyer_ck CHECK (length(btrim(buyer_id)) > 0),
  business_key text NOT NULL,
  method text NOT NULL CONSTRAINT signal_payments_method_ck CHECK (method IN ('card')),
  -- The card partner, as svc-market names it (`test-card` is the TEST partner card stand-in).
  partner_id text NOT NULL,
  asset_id text NOT NULL,
  amount text NOT NULL CONSTRAINT signal_payments_amount_ck CHECK (amount ~ '^[0-9]+(\.[0-9]+)?$'),
  -- pending: written, the partner not yet answered. approved: the partner took the payment. paid: our revenue and the
  -- partner's settlement are both posted. declined: the partner refused it, nothing posted.
  status text NOT NULL CONSTRAINT signal_payments_status_ck CHECK (status IN ('pending', 'approved', 'paid', 'declined')),
  partner_payment_id text,
  partner_settlement_id text,
  earned_tx_id text,
  collected_tx_id text,
  code text,
  test boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_payments_key_idx ON market.signal_payments (business_key);
CREATE UNIQUE INDEX IF NOT EXISTS signal_payments_buyer_idx ON market.signal_payments (listing_id, buyer_id);
