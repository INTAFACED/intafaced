-- Reverse 0005_support_audit_delete_refused.sql
-- Restores the 0001 foreign keys and the parent-absent exception.

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_ticket_id_fkey";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support"."tickets" ("id") ON DELETE CASCADE;

ALTER TABLE "support"."case_files" DROP CONSTRAINT IF EXISTS "case_files_ticket_id_fkey";
ALTER TABLE "support"."case_files" ADD CONSTRAINT "case_files_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support"."tickets" ("id") ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION "support"."ticket_events_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "support"."tickets" WHERE "id" = OLD."ticket_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'support.ticket_events is append-only: % refused on ticket %', TG_OP, OLD."ticket_id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "support"."case_files_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "support"."tickets" WHERE "id" = OLD."ticket_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'support.case_files is immutable: % refused on ticket %', TG_OP, OLD."ticket_id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
