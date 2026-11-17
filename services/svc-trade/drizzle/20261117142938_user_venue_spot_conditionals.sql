-- trade.user_venue_spot_conditionals · a person's conditional spot order on their own venue account (J-cex-spot-08;
-- src/venue/spot-conditionals.ts). Reversal: 20261117142938_user_venue_spot_conditionals.down.sql
--
-- A stop-limit, a stop-market, an OCO, a bracket or an entry with a linked close (one-triggers-other). A kind the venue
-- does not hold on spot (read from the market's own declaration, `triggerSources`) is held here and judged by our engine
-- on the venue's last traded price; when it fires, our engine sends one order on the person's own venue account, signed
-- by the venue agent key the person approved for it in their own wallet (the agent permission), under the business key
-- `spot-cond:fire:<owner>:<client_key>`. An OCO's take profit, a bracket's exits and a linked close rest on the venue as
-- ordinary limit orders under `spot-cond:<owner>:<client_key>:<leg>`. Nothing here is a balance and nothing is posted:
-- the venue holds the funds and the locks. A row is never deleted; its terms never change, except a live stop's trigger
-- and limit (modify) and an exit's size, set once from what the entry received.

CREATE TABLE IF NOT EXISTS trade.user_venue_spot_conditionals (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT user_venue_spot_conditionals_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_spot_conditionals_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  -- The person's own client order id: one order per id, so a replayed create is the same order.
  client_key text NOT NULL,
  kind text NOT NULL CONSTRAINT user_venue_spot_conditionals_kind_ck
    CHECK (kind IN ('stop_limit', 'stop_market', 'oco', 'bracket', 'oto')),
  symbol text NOT NULL,
  -- The stop's or the OCO's side; a bracket's or a linked close's entry side (its exits go the other way).
  side text NOT NULL CONSTRAINT user_venue_spot_conditionals_side_ck CHECK (side IN ('buy', 'sell')),
  quantity numeric(78, 18) NOT NULL CONSTRAINT user_venue_spot_conditionals_qty_ck CHECK (quantity > 0),
  -- The stop's (or the stop loss's) trigger and limit; a null limit fires as a market order at the owner's protection.
  trigger_price numeric(78, 18),
  limit_price numeric(78, 18),
  take_profit_price numeric(78, 18),
  entry_price numeric(78, 18),
  entry_tif text CONSTRAINT user_venue_spot_conditionals_tif_ck CHECK (entry_tif IS NULL OR entry_tif IN ('GTC', 'IOC')),
  close_price numeric(78, 18),
  -- A bracket's or linked close's exit size: what the entry received, set once when it is final.
  exit_quantity numeric(78, 18),
  agent_address text NOT NULL,
  -- The region of the request that made it: the engine checks trading from it again, with the live level, before it sends.
  region text NOT NULL,
  status text NOT NULL CONSTRAINT user_venue_spot_conditionals_status_ck
    CHECK (status IN ('entry', 'placing', 'open', 'armed', 'firing', 'cancelling', 'fired', 'filled', 'failed', 'cancelled')),
  failure text,
  cancel_reason text,
  fired_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT user_venue_spot_conditionals_fields_ck CHECK (
    (kind = 'stop_limit' AND trigger_price IS NOT NULL AND limit_price IS NOT NULL AND take_profit_price IS NULL AND entry_price IS NULL)
    OR (kind = 'stop_market' AND trigger_price IS NOT NULL AND limit_price IS NULL AND take_profit_price IS NULL AND entry_price IS NULL)
    OR (kind = 'oco' AND trigger_price IS NOT NULL AND take_profit_price IS NOT NULL AND entry_price IS NULL)
    OR (kind = 'bracket' AND trigger_price IS NOT NULL AND take_profit_price IS NOT NULL AND entry_price IS NOT NULL AND entry_tif IS NOT NULL)
    OR (kind = 'oto' AND entry_price IS NOT NULL AND entry_tif IS NOT NULL AND close_price IS NOT NULL AND trigger_price IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_venue_spot_conditionals_client_uq
  ON trade.user_venue_spot_conditionals (user_id, owner, client_key);
CREATE INDEX IF NOT EXISTS user_venue_spot_conditionals_live_idx
  ON trade.user_venue_spot_conditionals (status) WHERE status IN ('entry', 'placing', 'open', 'armed', 'firing', 'cancelling');

-- Never deleted; a final state stays final; only a live stop's trigger and limit, and an exit size set once, change.
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
DROP TRIGGER IF EXISTS user_venue_spot_conditionals_once_trg ON trade.user_venue_spot_conditionals;
CREATE TRIGGER user_venue_spot_conditionals_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_spot_conditionals
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_spot_conditionals_once();
