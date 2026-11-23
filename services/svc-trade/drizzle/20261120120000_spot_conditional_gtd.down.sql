-- Reverses 20261120120000_spot_conditional_gtd.sql. A good-till-date row doesn't fit the earlier checks, and the table's
-- trigger refuses a delete, so the reversal refuses to run while one exists: the record is never removed to fit.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM trade.user_venue_spot_conditionals WHERE kind = 'gtd' OR status = 'expired') THEN
    RAISE EXCEPTION 'trade.user_venue_spot_conditionals holds good-till-date orders; they are a record and are not removed';
  END IF;
END;
$$;
ALTER TABLE trade.user_venue_spot_conditionals DROP CONSTRAINT IF EXISTS user_venue_spot_conditionals_fields_ck;
ALTER TABLE trade.user_venue_spot_conditionals ADD CONSTRAINT user_venue_spot_conditionals_fields_ck CHECK (
  (kind = 'stop_limit' AND trigger_price IS NOT NULL AND limit_price IS NOT NULL AND take_profit_price IS NULL AND entry_price IS NULL)
  OR (kind = 'stop_market' AND trigger_price IS NOT NULL AND limit_price IS NULL AND take_profit_price IS NULL AND entry_price IS NULL)
  OR (kind = 'oco' AND trigger_price IS NOT NULL AND take_profit_price IS NOT NULL AND entry_price IS NULL)
  OR (kind = 'bracket' AND trigger_price IS NOT NULL AND take_profit_price IS NOT NULL AND entry_price IS NOT NULL AND entry_tif IS NOT NULL)
  OR (kind = 'oto' AND entry_price IS NOT NULL AND entry_tif IS NOT NULL AND close_price IS NOT NULL AND trigger_price IS NULL)
);
ALTER TABLE trade.user_venue_spot_conditionals DROP CONSTRAINT IF EXISTS user_venue_spot_conditionals_status_ck;
ALTER TABLE trade.user_venue_spot_conditionals ADD CONSTRAINT user_venue_spot_conditionals_status_ck
  CHECK (status IN ('entry', 'placing', 'open', 'armed', 'firing', 'cancelling', 'fired', 'filled', 'failed', 'cancelled'));
ALTER TABLE trade.user_venue_spot_conditionals DROP CONSTRAINT IF EXISTS user_venue_spot_conditionals_kind_ck;
ALTER TABLE trade.user_venue_spot_conditionals ADD CONSTRAINT user_venue_spot_conditionals_kind_ck
  CHECK (kind IN ('stop_limit', 'stop_market', 'oco', 'bracket', 'oto'));
CREATE OR REPLACE FUNCTION trade.user_venue_spot_conditionals_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_spot_conditionals: an order is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.owner IS DISTINCT FROM OLD.owner
     OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.client_key IS DISTINCT FROM OLD.client_key
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.symbol IS DISTINCT FROM OLD.symbol OR NEW.side IS DISTINCT FROM OLD.side
     OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.take_profit_price IS DISTINCT FROM OLD.take_profit_price
     OR NEW.entry_price IS DISTINCT FROM OLD.entry_price OR NEW.entry_tif IS DISTINCT FROM OLD.entry_tif
     OR NEW.close_price IS DISTINCT FROM OLD.close_price OR NEW.agent_address IS DISTINCT FROM OLD.agent_address
     OR NEW.region IS DISTINCT FROM OLD.region OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.exit_quantity IS NOT NULL AND NEW.exit_quantity IS DISTINCT FROM OLD.exit_quantity)
     OR ((NEW.trigger_price IS DISTINCT FROM OLD.trigger_price OR NEW.limit_price IS DISTINCT FROM OLD.limit_price)
         AND OLD.status NOT IN ('armed', 'open', 'entry'))
     OR OLD.status IN ('fired', 'filled', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'trade.user_venue_spot_conditionals: only a live order changes, and only its state, a live stop''s prices or its exit size once.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE trade.user_venue_spot_conditionals DROP COLUMN IF EXISTS expire_at;
