-- trade.venue_convert_quotes · J-cex-spot-11
-- Reversal: 20261118213635_venue_convert_quotes.down.sql
--
-- Convert's quotes on the customer's own venue account (src/venue/venue-convert.ts): the venue's best price as read, the
-- order's limit price inside the owner's slippage cap, its size, and the venue's own preview of its fees. Nothing here is
-- a balance, a lock or an order: a quote sends nothing to the venue and the ledger posts nothing. An accepted quote's one
-- venue order lives in trade.user_venue_actions under `convert:<owner>:<quote_id>`. A figure the venue does not give is
-- stored as not known (`*_known` false, its amount null), never as zero. Rows are written once, under the person's key.
CREATE TABLE IF NOT EXISTS trade.venue_convert_quotes (
  user_id text NOT NULL,
  quote_id text NOT NULL CONSTRAINT venue_convert_quotes_id_ck CHECK (quote_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  venue_id text NOT NULL CONSTRAINT venue_convert_quotes_venue_ck CHECK (length(btrim(venue_id)) BETWEEN 1 AND 64),
  test boolean NOT NULL,
  owner text NOT NULL CONSTRAINT venue_convert_quotes_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  market text NOT NULL,
  side text NOT NULL CONSTRAINT venue_convert_quotes_side_ck CHECK (side IN ('buy', 'sell')),
  from_asset text NOT NULL,
  to_asset text NOT NULL,
  spend numeric(38, 18) NOT NULL CONSTRAINT venue_convert_quotes_spend_ck CHECK (spend > 0),
  size numeric(38, 18) NOT NULL CONSTRAINT venue_convert_quotes_size_ck CHECK (size > 0),
  best_price numeric(38, 18) NOT NULL CONSTRAINT venue_convert_quotes_best_ck CHECK (best_price > 0),
  best_as_of timestamptz NOT NULL,
  limit_price numeric(38, 18) NOT NULL CONSTRAINT venue_convert_quotes_limit_ck CHECK (limit_price > 0),
  slippage_bps integer NOT NULL CONSTRAINT venue_convert_quotes_slippage_ck CHECK (slippage_bps BETWEEN 1 AND 5000),
  -- Null on a buy: the venue charges our builder fee on a spot sell only.
  builder_fee_bps numeric(38, 18),
  builder_fee_known boolean NOT NULL,
  builder_fee_amount numeric(38, 18),
  venue_fee_known boolean NOT NULL,
  venue_fee_amount numeric(38, 18),
  venue_fee_asset text,
  fill_known boolean NOT NULL,
  fill_amount numeric(38, 18),
  fill_average_price numeric(38, 18),
  fresh_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, quote_id),
  CONSTRAINT venue_convert_quotes_builder_fee_ck CHECK (
    (side = 'buy' AND builder_fee_bps IS NULL AND NOT builder_fee_known AND builder_fee_amount IS NULL)
    OR (side = 'sell' AND builder_fee_bps IS NOT NULL AND builder_fee_bps >= 0
        AND ((builder_fee_known AND builder_fee_amount IS NOT NULL AND builder_fee_amount >= 0)
             OR (NOT builder_fee_known AND builder_fee_amount IS NULL)))
  ),
  CONSTRAINT venue_convert_quotes_venue_fee_ck CHECK (
    (venue_fee_known AND venue_fee_amount IS NOT NULL AND venue_fee_asset IS NOT NULL)
    OR (NOT venue_fee_known AND venue_fee_amount IS NULL AND venue_fee_asset IS NULL)
  ),
  CONSTRAINT venue_convert_quotes_fill_ck CHECK (
    (fill_known AND fill_amount IS NOT NULL AND fill_amount >= 0)
    OR (NOT fill_known AND fill_amount IS NULL AND fill_average_price IS NULL)
  )
);
