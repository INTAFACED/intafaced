-- svc-support · records linked to a request (J-support-public-20 #1)
-- Reversal: 20261102013926_ticket_record_links.down.sql
--
-- One row per order, withdrawal or deposit the desk linked to a ticket, written only after the service that owns the
-- record said it is the ticket's customer's. The row holds the kind and the owner's record id, who linked it and when:
-- no amount, status, asset or address. A record links to a ticket once; the table refuses update and delete.

CREATE TABLE IF NOT EXISTS "support"."ticket_record_links" (
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('order', 'withdrawal', 'deposit')),
  "record_id" uuid NOT NULL,
  "linked_by" text NOT NULL CHECK (char_length("linked_by") BETWEEN 1 AND 128),
  "linked_at" timestamptz NOT NULL,
  PRIMARY KEY ("ticket_id", "kind", "record_id")
);

CREATE OR REPLACE FUNCTION "support"."ticket_record_links_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.ticket_record_links is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ticket_record_links_append_only_trg" ON "support"."ticket_record_links";
CREATE TRIGGER "ticket_record_links_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."ticket_record_links"
  FOR EACH ROW EXECUTE FUNCTION "support"."ticket_record_links_append_only"();
