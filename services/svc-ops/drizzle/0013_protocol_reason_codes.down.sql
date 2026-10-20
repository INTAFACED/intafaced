-- intafaced:destructive — reversal of 0013_protocol_reason_codes.sql
--
-- This drops the edit history of the reason code list. The guard refuses to roll back while any edit exists: archive them first.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM ops.protocol_reason_code_changes) THEN
  RAISE EXCEPTION 'protocol reason code edits exist; archive them before rolling back';
 END IF;
END
$$;
DROP TRIGGER protocol_reason_code_changes_append_only ON ops.protocol_reason_code_changes;
DROP FUNCTION ops.protocol_reason_code_changes_append_only();
DROP TABLE ops.protocol_reason_code_changes;
