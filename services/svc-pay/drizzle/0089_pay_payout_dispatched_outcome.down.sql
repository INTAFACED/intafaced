-- Restores the pre-0089 kind check. Fails if a dispatched row exists: those
-- rows are immutable, and the old check cannot hold them.

ALTER TABLE pay.payout_outcomes DROP CONSTRAINT IF EXISTS payout_outcomes_kind_check;

ALTER TABLE pay.payout_outcomes ADD CONSTRAINT payout_outcomes_kind_check CHECK (
  kind IN (
    'rail_accepted',
    'rail_refused',
    'settled',
    'reversed',
    'identity_requested',
    'identity_granted',
    'identity_cancelled'
  )
);
