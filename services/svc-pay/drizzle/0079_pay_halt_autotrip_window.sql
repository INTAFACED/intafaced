-- When auto-trip may start counting. One row, written only after a process
-- observes a configured failure count (PAY_HALT_AUTOTRIP_FAILURES) or a per-rail
-- count (PAY_HALT_AUTOTRIP_RAIL_FAILURES). A null count with disarmed_at set
-- means a later process booted with that count unset: the next arm opens a
-- fresh window so a stale streak cannot trip. No row means that count was
-- never configured.
CREATE TABLE pay.halt_autotrip_window (
  singleton text PRIMARY KEY CHECK (singleton = 'autotrip'),
  failures bigint CHECK (failures IS NULL OR failures >= 1),
  effective_at timestamptz,
  disarmed_at timestamptz,
  rail_failures bigint CHECK (rail_failures IS NULL OR rail_failures >= 1),
  rail_effective_at timestamptz,
  rail_disarmed_at timestamptz,
  CHECK (
    (failures IS NULL AND effective_at IS NULL)
    OR (failures IS NOT NULL AND effective_at IS NOT NULL AND disarmed_at IS NULL)
  ),
  CHECK (
    (rail_failures IS NULL AND rail_effective_at IS NULL)
    OR (rail_failures IS NOT NULL AND rail_effective_at IS NOT NULL AND rail_disarmed_at IS NULL)
  )
);

-- Losing the row would move the window. Clearing a halt does not clear this.
CREATE TRIGGER pay_halt_autotrip_window_no_delete
  BEFORE DELETE ON pay.halt_autotrip_window
  FOR EACH ROW EXECUTE FUNCTION pay.halt_rows_not_deletable();

-- One auto-trip count per durable rail outcome, so a crash retry does not
-- count the same refusal twice. Counting never moves money.
CREATE TABLE pay.halt_autotrip_counted (
  event_key text PRIMARY KEY CHECK (length(btrim(event_key)) > 0),
  counted_at timestamptz NOT NULL DEFAULT now()
);

-- Halt targets gained user:<uuid> (one withdrawal exit) and rail:<id> (one
-- rail, every merchant). Merchant ids and 'global' stay valid.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
   WHERE con.conrelid = 'pay.halts'::regclass
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) LIKE '%target = ''global''%'
   LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pay.halts DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE pay.halts ADD CONSTRAINT pay_halts_target_kind_check CHECK (
  target = 'global'
  OR target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR target ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR target ~ '^rail:[a-z0-9][a-z0-9._-]{0,63}$'
);
