-- intafaced:destructive — reversal of 0116_pay_custody_approval_tasks.sql
--
-- Drops the custody approval tasks, their decisions and events, the approver registry and the quorum history. No balance
-- lives in these tables; this is for CI proof of reversibility and a database that stored no real task.

DROP TRIGGER IF EXISTS "custody_task_events_append_only_trg" ON "pay"."custody_task_events";
DROP TRIGGER IF EXISTS "custody_task_decisions_append_only_trg" ON "pay"."custody_task_decisions";
DROP TRIGGER IF EXISTS "custody_approver_events_append_only_trg" ON "pay"."custody_approver_events";
DROP TRIGGER IF EXISTS "custody_task_quorum_events_append_only_trg" ON "pay"."custody_task_quorum_events";
DROP FUNCTION IF EXISTS "pay"."custody_tasks_append_only"();
DROP INDEX IF EXISTS "pay"."custody_task_events_task_idx";
DROP TABLE IF EXISTS "pay"."custody_task_events";
DROP TABLE IF EXISTS "pay"."custody_task_decisions";
DROP INDEX IF EXISTS "pay"."custody_tasks_due_idx";
DROP INDEX IF EXISTS "pay"."custody_tasks_status_idx";
DROP TABLE IF EXISTS "pay"."custody_tasks";
DROP INDEX IF EXISTS "pay"."custody_approver_latest_idx";
DROP TABLE IF EXISTS "pay"."custody_approver_events";
DROP INDEX IF EXISTS "pay"."custody_task_quorum_latest_idx";
DROP TABLE IF EXISTS "pay"."custody_task_quorum_events";
