-- intafaced:destructive — reversal of 20261029213000_audit_log_reads.sql
DROP TABLE IF EXISTS "agents"."agent_transcripts";
DROP TABLE IF EXISTS "agents"."agent_log_reads";
DROP FUNCTION IF EXISTS "agents"."agent_log_reads_append_only"();
