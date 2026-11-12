-- trade.user_venue_engine_protections · a person's protection that runs on our engine, not on the venue (J-derivatives-03
-- #5 #6; src/venue/protections.ts). Reversal: 20261112090000_user_venue_engine_protections.down.sql
--
-- A kind the venue does not take (a trailing stop, or a stop judged on the venue's index price) is held here and judged
-- by our engine on the venue's own published prices. When it fires, our engine sends one reduce-only market order on the
-- person's own venue account, signed by the venue agent key the person approved for it in their own wallet (the agent
-- permission), under the business key `protection:fire:<id>`. Nothing here is a balance and nothing is posted: the venue
-- holds the position and the margin. A row is never deleted; it moves armed → firing → fired | failed | cancelled once.

CREATE TABLE IF NOT EXISTS trade.user_venue_engine_protections (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT user_venue_engine_protections_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_engine_protections_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  -- The person's own client order id: one protection per id, so a retried create is the same protection.
  client_key text NOT NULL,
  symbol text NOT NULL,
  kind text NOT NULL CONSTRAINT user_venue_engine_protections_kind_ck CHECK (kind IN ('stop_market', 'trailing_stop')),
  side text NOT NULL CONSTRAINT user_venue_engine_protections_side_ck CHECK (side IN ('buy', 'sell')),
  quantity numeric(78, 18) NOT NULL CONSTRAINT user_venue_engine_protections_qty_ck CHECK (quantity > 0),
  trigger_source text NOT NULL CONSTRAINT user_venue_engine_protections_source_ck CHECK (trigger_source IN ('mark', 'index')),
  trigger_price numeric(78, 18),
  trailing_distance numeric(78, 18),
  -- A trailing stop's best price seen since it armed, on its source: the trigger trails it by the distance.
  best_price numeric(78, 18),
  agent_address text NOT NULL,
  status text NOT NULL CONSTRAINT user_venue_engine_protections_status_ck CHECK (status IN ('armed', 'firing', 'fired', 'failed', 'cancelled')),
  failure text,
  cancel_reason text,
  fired_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT user_venue_engine_protections_fields_ck CHECK (
    (kind = 'stop_market' AND trigger_price IS NOT NULL AND trailing_distance IS NULL)
    OR (kind = 'trailing_stop' AND trigger_price IS NULL AND trailing_distance IS NOT NULL AND best_price IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_venue_engine_protections_client_uq
  ON trade.user_venue_engine_protections (user_id, client_key);
CREATE INDEX IF NOT EXISTS user_venue_engine_protections_live_idx
  ON trade.user_venue_engine_protections (status) WHERE status IN ('armed', 'firing');

-- Never deleted, its terms never change, and a final state stays final.
CREATE OR REPLACE FUNCTION trade.user_venue_engine_protections_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_engine_protections: a protection is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.owner IS DISTINCT FROM OLD.owner
     OR NEW.client_key IS DISTINCT FROM OLD.client_key OR NEW.symbol IS DISTINCT FROM OLD.symbol OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.side IS DISTINCT FROM OLD.side OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.trigger_source IS DISTINCT FROM OLD.trigger_source OR NEW.trigger_price IS DISTINCT FROM OLD.trigger_price
     OR NEW.trailing_distance IS DISTINCT FROM OLD.trailing_distance OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status IN ('fired', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'trade.user_venue_engine_protections: only a live protection changes, and only its state.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_venue_engine_protections_once_trg ON trade.user_venue_engine_protections;
CREATE TRIGGER user_venue_engine_protections_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_engine_protections
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_engine_protections_once();
