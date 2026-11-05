-- Reverses the own agent inbox index migration.
DROP INDEX IF EXISTS "agents"."own_agent_approval_requests_inbox_idx";
