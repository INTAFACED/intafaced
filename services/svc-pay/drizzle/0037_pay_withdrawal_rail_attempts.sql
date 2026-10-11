-- Original withdrawal rows remain authoritative for amount, asset, user and destination.
-- Dispatch outcomes are receipts, never balances. Legacy held rows remain unknown.
CREATE TABLE pay.withdrawal_rail_attempts (
  withdrawal_id uuid NOT NULL REFERENCES pay.withdrawals(id),
  attempt integer NOT NULL CHECK (attempt >= 0),
  outcome text NOT NULL CHECK (outcome IN ('requested', 'accepted', 'refused')),
  rail_ref text,
  PRIMARY KEY (withdrawal_id, attempt),
  CHECK ((outcome = 'accepted') = (rail_ref IS NOT NULL AND length(btrim(rail_ref)) > 0))
);

CREATE FUNCTION pay.withdrawal_terms_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.user_id, NEW.asset_id, NEW.amount, NEW.rail, NEW.destination, NEW.client_ref)
    IS DISTINCT FROM ROW(OLD.user_id, OLD.asset_id, OLD.amount, OLD.rail, OLD.destination, OLD.client_ref) THEN
   RAISE EXCEPTION 'Original withdrawal terms are immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_terms_frozen_trg BEFORE UPDATE ON pay.withdrawals
 FOR EACH ROW EXECUTE FUNCTION pay.withdrawal_terms_frozen();
