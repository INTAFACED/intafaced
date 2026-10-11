-- Independently deployed mailbox receipts. No recipient, body, notification ID,
-- upstream credential or response body belongs in this database.
CREATE TABLE IF NOT EXISTS notify.mailbox_relay_receipts (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  envelope_hash text NOT NULL CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  gateway_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('attempting','accepted','refused','unknown')),
  upstream_status smallint CHECK (upstream_status IN (401,403,422)),
  attempted_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL CHECK (deadline_at > attempted_at),
  settled_at timestamptz,
  CHECK ((status = 'attempting') = (settled_at IS NULL)),
  CHECK ((status = 'refused') = (upstream_status IS NOT NULL))
);
CREATE OR REPLACE FUNCTION notify.mailbox_relay_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Mailbox relay receipts cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(OLD.key_hash,OLD.envelope_hash,OLD.gateway_id,OLD.attempted_at,OLD.deadline_at)
    IS DISTINCT FROM ROW(NEW.key_hash,NEW.envelope_hash,NEW.gateway_id,NEW.attempted_at,NEW.deadline_at)
    OR (OLD.status <> 'attempting' AND OLD IS DISTINCT FROM NEW)
  THEN RAISE EXCEPTION 'Mailbox relay attempt and terminal receipt are immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.status IN ('accepted','refused') AND clock_timestamp() >= OLD.deadline_at THEN
    RAISE EXCEPTION 'Mailbox relay final receipt deadline expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
-- Check again at commit: a delayed statement/trigger must not manufacture a
-- final receipt after the bounded attempt expired.
CREATE OR REPLACE FUNCTION notify.mailbox_relay_commit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('accepted','refused') AND clock_timestamp() >= NEW.deadline_at THEN
    RAISE EXCEPTION 'Mailbox relay commit deadline expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'notify.mailbox_relay_receipts'::regclass AND tgname = 'mailbox_relay_immutable') THEN
    CREATE TRIGGER mailbox_relay_immutable BEFORE UPDATE OR DELETE ON notify.mailbox_relay_receipts
      FOR EACH ROW EXECUTE FUNCTION notify.mailbox_relay_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'notify.mailbox_relay_receipts'::regclass AND tgname = 'mailbox_relay_commit_deadline') THEN
    CREATE CONSTRAINT TRIGGER mailbox_relay_commit_deadline AFTER UPDATE ON notify.mailbox_relay_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.mailbox_relay_commit_deadline();
  END IF;
END $$;
