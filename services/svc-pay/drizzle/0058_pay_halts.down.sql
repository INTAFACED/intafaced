-- intafaced:destructive — halt history is an audit trail; refuse to drop it once any halt was ever recorded.
LOCK TABLE pay.halts, pay.halt_events, pay.halt_clear_requests, pay.halt_failure_streaks IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pay.halt_events) THEN
    RAISE EXCEPTION 'pay.halt_events history prevents downgrade';
  END IF;
END $$;
DROP TABLE pay.halt_failure_streaks;
DROP TABLE pay.halt_clear_requests;
DROP TABLE pay.halt_events;
DROP TABLE pay.halts;
DROP FUNCTION pay.halt_rows_not_deletable();
