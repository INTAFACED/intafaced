-- trade.venue_sell_quotes · J-cex-spot-17 #8
-- Reversal: 20261110023522_venue_sell_quotes.down.sql
--
-- Convert's sell quotes on the customer's own venue account (src/venue/venue-sell-quotes.ts): the venue's own preview of
-- a market sell of that size, stored exactly as the venue gave it, for finance to read. Nothing here is a balance, a lock
-- or an order: a quote sends nothing to the venue and the ledger posts nothing. A figure the venue does not give is
-- stored as not known (`*_known` false, its amount null), never as zero. Rows are written once, under their business key.
CREATE TABLE IF NOT EXISTS trade.venue_sell_quotes (
  quote_id text PRIMARY KEY CONSTRAINT venue_sell_quotes_id_ck CHECK (length(quote_id) BETWEEN 1 AND 200),
  user_id text NOT NULL,
  venue_id text NOT NULL CONSTRAINT venue_sell_quotes_venue_ck CHECK (length(btrim(venue_id)) BETWEEN 1 AND 64),
  proof_level text NOT NULL CONSTRAINT venue_sell_quotes_proof_ck CHECK (proof_level IN ('simulator', 'partner-sandbox', 'live')),
  owner text NOT NULL CONSTRAINT venue_sell_quotes_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  symbol text NOT NULL,
  base_asset text NOT NULL,
  quote_asset text NOT NULL,
  amount numeric(38, 18) NOT NULL CONSTRAINT venue_sell_quotes_amount_ck CHECK (amount > 0),
  fill_known boolean NOT NULL,
  fill_amount numeric(38, 18),
  fill_average_price numeric(38, 18),
  venue_fee_known boolean NOT NULL,
  venue_fee_amount numeric(38, 18),
  venue_fee_asset text,
  builder_fee_known boolean NOT NULL,
  builder_fee_amount numeric(38, 18),
  builder_fee_asset text,
  as_of timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT venue_sell_quotes_fill_ck CHECK (
    (fill_known AND fill_amount IS NOT NULL AND fill_amount >= 0 AND fill_amount <= amount
       AND ((fill_amount = 0) = (fill_average_price IS NULL)))
    OR (NOT fill_known AND fill_amount IS NULL AND fill_average_price IS NULL)
  ),
  CONSTRAINT venue_sell_quotes_venue_fee_ck CHECK (
    (venue_fee_known AND venue_fee_amount IS NOT NULL AND venue_fee_amount >= 0 AND venue_fee_asset IS NOT NULL)
    OR (NOT venue_fee_known AND venue_fee_amount IS NULL AND venue_fee_asset IS NULL)
  ),
  CONSTRAINT venue_sell_quotes_builder_fee_ck CHECK (
    (builder_fee_known AND builder_fee_amount IS NOT NULL AND builder_fee_amount >= 0 AND builder_fee_asset IS NOT NULL)
    OR (NOT builder_fee_known AND builder_fee_amount IS NULL AND builder_fee_asset IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS venue_sell_quotes_created_idx ON trade.venue_sell_quotes (created_at DESC, quote_id DESC);
