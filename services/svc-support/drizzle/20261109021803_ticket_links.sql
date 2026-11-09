-- svc-support · a request's links to the customer's own order, withdrawal or deposit (J-support-public-20 #1)
-- Reversal: 20261109021803_ticket_links.down.sql
--
-- One row per record linked to a request, once per (ticket, kind, record). A record is linked only after the service that
-- owns it said it belongs to the ticket's customer: svc-trade for an order, svc-pay for a withdrawal or a deposit.
-- `recovery_required` records that svc-trade read the order as `recovery_required` or `hold_unknown` at link time. The queue
-- reads each open request's linked orders from svc-trade again and uses this only when svc-trade gives no answer. The row
-- holds no amount and no other field of the record. It refuses update and delete.

CREATE TABLE IF NOT EXISTS "support"."ticket_links" (
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('order', 'withdrawal', 'deposit')),
  "record_id" uuid NOT NULL,
  "recovery_required" boolean NOT NULL DEFAULT false,
  "linked_by" text NOT NULL CHECK (char_length("linked_by") BETWEEN 1 AND 128),
  "linked_at" timestamptz NOT NULL,
  PRIMARY KEY ("ticket_id", "kind", "record_id"),
  CHECK ("kind" = 'order' OR NOT "recovery_required")
);

CREATE INDEX IF NOT EXISTS "ticket_links_orders_idx" ON "support"."ticket_links" ("ticket_id") WHERE "kind" = 'order';

CREATE OR REPLACE FUNCTION "support"."ticket_links_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'support.ticket_links is append-only';
END
$$;
DROP TRIGGER IF EXISTS "ticket_links_append_only" ON "support"."ticket_links";
CREATE TRIGGER "ticket_links_append_only" BEFORE UPDATE OR DELETE ON "support"."ticket_links"
  FOR EACH ROW EXECUTE FUNCTION "support"."ticket_links_append_only"();
