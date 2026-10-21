-- svc-support · merge duplicate requests (SP-tickets-07)
-- Reversal: 0026_ticket_merges.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds one table and widens one CHECK. `ticket_merges` is the merged-into link and
-- the stored result of a merge: one row per source request (a source is closed by its merge and merges once), so a replay of
-- the same (source, survivor) returns this row and moves nothing twice. The trail gains a `merged` kind, written on both
-- requests in the same transaction as the move.

CREATE TABLE IF NOT EXISTS "support"."ticket_merges" (
  "source_id" uuid PRIMARY KEY REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "survivor_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL,
  "comments_moved" integer NOT NULL,
  "attachments_moved" integer NOT NULL,
  "merged_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ticket_merges_distinct_ck" CHECK ("source_id" <> "survivor_id"),
  CONSTRAINT "ticket_merges_counts_ck" CHECK ("comments_moved" >= 0 AND "attachments_moved" >= 0)
);

CREATE INDEX IF NOT EXISTS "ticket_merges_survivor_idx" ON "support"."ticket_merges" ("survivor_id");

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_kind_ck";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_kind_ck"
  CHECK ("kind" IN ('opened', 'assigned', 'status_changed', 'grounding_read', 'escalated', 'merged'));
