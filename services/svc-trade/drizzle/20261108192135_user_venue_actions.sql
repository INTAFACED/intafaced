-- trade.user_venue_actions · one prepared, wallet-signed venue action per business key (B1; project-state #1789 item 2)
-- Reversal: 20261108192135_user_venue_actions.down.sql
--
-- The user-venue door (src/venue/) stores the action a venue prepared for an intent BEFORE the wallet is asked, and the
-- signature once the wallet gives it, under the intent's business key (`order:...`, `withdraw:...`). A second prepare of
-- the key returns this row, so a double press is one action and one signature; a re-submit after an answer that was
-- not definite re-sends these exact bytes. The venue is the record of what happened: nothing here is a balance, a lock
-- or a fill, and the ledger posts nothing for it.

CREATE TABLE IF NOT EXISTS trade.user_venue_actions (
  user_id text NOT NULL CONSTRAINT user_venue_actions_user_ck CHECK (length(btrim(user_id)) > 0),
  business_key text NOT NULL CONSTRAINT user_venue_actions_key_ck CHECK (length(business_key) BETWEEN 3 AND 200),
  venue_id text NOT NULL,
  kind text NOT NULL,
  -- The prepared action exactly as the venue returned it, every Amount as a decimal string (encodeVenueWire).
  prepared jsonb NOT NULL,
  digest text NOT NULL,
  -- The wallet's signature over `digest`, set once and never changed.
  signature jsonb,
  -- The venue's latest answer to a submit, as a record of what was asked; the venue stays the record of the outcome.
  last_outcome jsonb,
  created_at timestamptz NOT NULL,
  signed_at timestamptz,
  submitted_at timestamptz,
  PRIMARY KEY (user_id, business_key),
  CONSTRAINT user_venue_actions_signed_ck CHECK ((signature IS NULL) = (signed_at IS NULL))
);

-- A stored action never changes, and its signature is written once.
CREATE OR REPLACE FUNCTION trade.user_venue_actions_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_actions: a prepared action is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.business_key IS DISTINCT FROM OLD.business_key
     OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.prepared IS DISTINCT FROM OLD.prepared OR NEW.digest IS DISTINCT FROM OLD.digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.signature IS NOT NULL AND (NEW.signature IS DISTINCT FROM OLD.signature OR NEW.signed_at IS DISTINCT FROM OLD.signed_at)) THEN
    RAISE EXCEPTION 'trade.user_venue_actions: only the first signature and the latest answer may be written.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_venue_actions_write_once_trg ON trade.user_venue_actions;
CREATE TRIGGER user_venue_actions_write_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_actions
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_actions_write_once();
