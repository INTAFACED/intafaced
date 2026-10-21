-- intafaced:destructive — reversal of 0012_restore_runs.sql
--
-- This drops the joint restore runs and their append-only step log, which is the evidence of what was restored and who
-- approved it. The guard refuses to roll back while any run exists: archive them first.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM ops.restore_runs) THEN
  RAISE EXCEPTION 'restore runs exist; archive them before rolling back, or the record of what was restored is lost';
 END IF;
END
$$;
DROP TABLE ops.restore_outbox;
DROP TRIGGER restore_steps_append_only ON ops.restore_steps;
DROP FUNCTION ops.restore_steps_append_only();
DROP TABLE ops.restore_steps;
DROP TABLE ops.restore_runs;
