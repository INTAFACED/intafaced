-- svc-support · audit rows stay when the ticket row does not (L1239)
-- Reversal: 0005_support_audit_delete_refused.down.sql
--
-- NOT tagged `intafaced:destructive`: it replaces two functions and rewrites
-- two foreign keys in place. It drops no table, no column, and no row.
--
-- 0001's ticket_events_append_only and case_files_immutable allowed a child
-- row to go once the parent ticket was already absent. That is the moment
-- ON DELETE CASCADE reaches the child, so a ticket removal erased the trail
-- and the case file. The permanent key is the row id. Parent absence is not
-- permission to remove the row.
--
-- The foreign keys are no longer ON DELETE CASCADE. Removing a ticket cannot
-- take these rows with it. Both triggers refuse UPDATE and row removal with
-- no exception for a missing parent.

CREATE OR REPLACE FUNCTION "support"."ticket_events_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.ticket_events is append-only: % refused on id %', TG_OP, OLD."id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ticket_events_append_only_trg" ON "support"."ticket_events";
CREATE TRIGGER "ticket_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."ticket_events"
  FOR EACH ROW EXECUTE FUNCTION "support"."ticket_events_append_only"();

CREATE OR REPLACE FUNCTION "support"."case_files_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.case_files is immutable: % refused on id %', TG_OP, OLD."id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "case_files_immutable_trg" ON "support"."case_files";
CREATE TRIGGER "case_files_immutable_trg"
  BEFORE UPDATE OR DELETE ON "support"."case_files"
  FOR EACH ROW EXECUTE FUNCTION "support"."case_files_immutable"();

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_ticket_id_fkey";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT;

ALTER TABLE "support"."case_files" DROP CONSTRAINT IF EXISTS "case_files_ticket_id_fkey";
ALTER TABLE "support"."case_files" ADD CONSTRAINT "case_files_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT;
