-- svc-ledger · pause, resume and retire a reconciliation control (OPS-reconciliation-02)
-- Reversal: 20261029130725_reconciliation_control_lifecycle.down.sql
-- intafaced:destructive drops reconciliation_controls_state_ck only to re-add it wider in the same statement; no row changes.
--
-- paused runs nothing (neither the scheduler nor a run on demand) until it is resumed with a complete policy.
-- retired is final: the row, its runs and its audit stay. Built-in rows stay active (builtin_active_ck).
-- resumed_at is the last resume: the scheduler does not catch up a period that fell due before it (paused time).

ALTER TABLE "ledger"."reconciliation_controls"
  DROP CONSTRAINT "reconciliation_controls_state_ck",
  ADD CONSTRAINT "reconciliation_controls_state_ck" CHECK ("state" IN ('draft', 'active', 'paused', 'retired'));

ALTER TABLE "ledger"."reconciliation_controls" ADD COLUMN "resumed_at" timestamp with time zone;
