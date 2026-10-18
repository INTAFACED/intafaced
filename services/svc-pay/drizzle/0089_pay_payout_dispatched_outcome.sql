-- Merchant settlement payout: a dispatched marker before the rail call.
-- Reversal: 0089_pay_payout_dispatched_outcome.down.sql
--
-- payout_outcomes.kind rejected anything but the original seven values, so a
-- dispatch journal could not be stored. 'dispatched' is that journal. It is
-- not a rail answer: rail_accepted and rail_refused stay the only rail terminals.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
   WHERE con.conrelid = 'pay.payout_outcomes'::regclass
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) LIKE '%rail_accepted%'
   LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pay.payout_outcomes DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE pay.payout_outcomes ADD CONSTRAINT payout_outcomes_kind_check CHECK (
  kind IN (
    'rail_accepted',
    'rail_refused',
    'settled',
    'reversed',
    'identity_requested',
    'identity_granted',
    'identity_cancelled',
    'dispatched'
  )
);
