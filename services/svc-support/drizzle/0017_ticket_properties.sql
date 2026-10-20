-- svc-support · agent-set ticket properties (SP-tickets-04)
-- Reversal: 0017_ticket_properties.down.sql
--
-- Priority, type and labels are set by staff and read by staff only; they are
-- kept beside the ticket, not on it, because the ticket owner reads the ticket
-- row. A ticket with no row here has none set. Every change is appended to the
-- log with who made it and why.

CREATE TABLE IF NOT EXISTS "support"."ticket_properties" (
  "ticket_id" uuid PRIMARY KEY REFERENCES "support"."tickets" ("id") ON DELETE CASCADE,
  "priority" text CHECK ("priority" IS NULL OR "priority" IN ('low', 'normal', 'high', 'urgent')),
  "ticket_type" text CHECK ("ticket_type" IS NULL OR "ticket_type" IN ('question', 'problem', 'incident')),
  "labels" text[] NOT NULL DEFAULT '{}',
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "ticket_properties_labels_idx" ON "support"."ticket_properties" USING gin ("labels");

CREATE TABLE IF NOT EXISTS "support"."ticket_property_log" (
  "id" bigserial PRIMARY KEY,
  "ticket_id" uuid NOT NULL,
  "before" jsonb NOT NULL,
  "after" jsonb NOT NULL,
  "set_by" text NOT NULL,
  "reason" text CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "ticket_property_log_ticket_idx" ON "support"."ticket_property_log" ("ticket_id", "id");
