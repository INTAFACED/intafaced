-- When auto-trip may start counting. One row, written only after a process
-- observes a configured failure count (PAY_HALT_AUTOTRIP_FAILURES). effective_at
-- is that configuration's start, not the start of whichever process is running:
-- a later process with the same count keeps this timestamp. A different count
-- moves effective_at and the streak writer drops the old run. No row means the
-- count was never configured, so nothing is armed.
CREATE TABLE pay.halt_autotrip_window (
  singleton text PRIMARY KEY CHECK (singleton = 'autotrip'),
  failures bigint NOT NULL CHECK (failures >= 1),
  effective_at timestamptz NOT NULL
);

-- Losing the row would move the window. Clearing a halt does not clear this.
CREATE TRIGGER pay_halt_autotrip_window_no_delete
  BEFORE DELETE ON pay.halt_autotrip_window
  FOR EACH ROW EXECUTE FUNCTION pay.halt_rows_not_deletable();
