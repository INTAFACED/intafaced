-- svc-support · status_changed names only a ticket status (L1240)
-- Reversal: 0006_support_status_pair_enum.down.sql
--
-- NOT tagged `intafaced:destructive`: it replaces ticket_events_status_pair_ck
-- in place. It drops no table, no column, and no row. The same constraint name
-- comes back stricter.
--
-- 0001 required a status_changed row to carry two non-null statuses that
-- differ. It did not limit those strings to the set tickets.status already
-- allows (0000 tickets_status_ck): open, pending, resolved, closed. An empty
-- string, or any other word, could be written as history of a status the
-- ticket row is not allowed to hold.
--
-- IS NOT NULL stays. A CHECK expression that comes out NULL is treated as
-- passed, and NULL IN (...) is NULL, so the list alone would let a
-- status_changed row through with both sides null.

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_status_pair_ck";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_status_pair_ck"
  CHECK (
    ("kind" <> 'status_changed' AND "from_status" IS NULL AND "to_status" IS NULL)
    OR (
      "kind" = 'status_changed'
      AND "from_status" IS NOT NULL
      AND "to_status" IS NOT NULL
      AND "from_status" IN ('open', 'pending', 'resolved', 'closed')
      AND "to_status" IN ('open', 'pending', 'resolved', 'closed')
      AND "from_status" <> "to_status"
    )
  );
