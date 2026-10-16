-- intafaced:destructive — drops the auto-trip window timestamp. Halt rows and
-- their history are untouched; a deploy that still has a configured count
-- starts a new window the next time it records a failure.
DROP TRIGGER IF EXISTS pay_halt_autotrip_window_no_delete ON pay.halt_autotrip_window;
DROP TABLE IF EXISTS pay.halt_autotrip_window;
