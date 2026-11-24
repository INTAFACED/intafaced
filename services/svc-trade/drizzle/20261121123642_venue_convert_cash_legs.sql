-- trade.venue_convert_quotes: the cash leg of a cash-through-a-coin convert · J-cex-spot-11 #11
-- Reversal: 20261121123642_venue_convert_cash_legs.down.sql
--
-- A convert from a cash currency is two linked legs (src/venue/venue-convert.ts): the partner's cash leg, the person's cash
-- for the venue's quote coin paid into their own venue account (svc-bank `convertCash.carry`), then the one venue order the
-- quote already describes. The quote keeps what the cash leg was priced with: the cash, the partner's rate and label, and
-- the coin the second leg spends. `cash_accepted_at` is when the person accepted it, so Recent conversions lists the
-- conversion as one record even when its venue order was never signed. The leg itself, what was paid and delivered, is the
-- partner's record, read from svc-bank, never kept here. A plain one-leg quote leaves every column null.
ALTER TABLE trade.venue_convert_quotes
  ADD COLUMN IF NOT EXISTS cash_asset text,
  ADD COLUMN IF NOT EXISTS cash_coin text,
  ADD COLUMN IF NOT EXISTS cash_rate numeric(38, 18),
  ADD COLUMN IF NOT EXISTS cash_coin_spend numeric(38, 18),
  ADD COLUMN IF NOT EXISTS cash_label text,
  ADD COLUMN IF NOT EXISTS cash_test boolean,
  ADD COLUMN IF NOT EXISTS cash_accepted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'venue_convert_quotes_cash_ck') THEN
    ALTER TABLE trade.venue_convert_quotes ADD CONSTRAINT venue_convert_quotes_cash_ck CHECK (
      (cash_asset IS NULL AND cash_coin IS NULL AND cash_rate IS NULL AND cash_coin_spend IS NULL AND cash_label IS NULL AND cash_test IS NULL
        AND cash_accepted_at IS NULL)
      OR (cash_asset ~ '^[A-Z]{3}$' AND cash_coin IS NOT NULL AND cash_rate > 0 AND cash_coin_spend > 0 AND cash_label IS NOT NULL AND cash_test IS NOT NULL)
    );
  END IF;
END $$;
