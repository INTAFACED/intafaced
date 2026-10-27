-- intafaced:destructive — reversal of 20261024110000_service_records.sql
--
-- Lossy by nature: every module's owner, dependencies and runbook, and their log, are dropped. With them gone every
-- service page reads "owner not set".
DROP TRIGGER IF EXISTS service_record_log_append_only ON ops.service_record_log;
DROP TABLE IF EXISTS ops.service_record_log;
DROP TABLE IF EXISTS ops.service_records;
