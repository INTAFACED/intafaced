-- One-tap reverse of a futures position (J-derivatives-03 step 9, D-account-03).
-- Reversal: 20261024055254_futures_reverse_requests.down.sql
--
-- One row per reverse: the trader's request id, the position it reverses, and the two legs it places through the
-- book under the request's own keys, `rv:c:<request>` (reduce-only, the whole size) and `rv:o:<request>` (the other
-- side, the same size, the position's leverage). A position has at most one reverse working at a time; one that
-- ended leaves room for another request (after a close_incomplete the rest of the position is still open).
-- closing (the close is placed or about to be), opening (the close settled; the open is next), done (the open
-- filled), opened_part (the open ended with less than the size), closed_only (the close stands and the open was
-- refused or not sent, or another order closed the position first; refusal_code says why), close_incomplete (the
-- close ended with less than the size, so nothing was opened), refused (the close was refused and this reverse
-- changed nothing). open_sent_at is set just before each send of the open, so the reconciler never reports a row
-- closed_only while its open may be on its way.
CREATE TABLE IF NOT EXISTS "trade"."futures_reverse_requests" (
  "id"                uuid            PRIMARY KEY,
  "user_id"           text            NOT NULL,
  "client_request_id" text            NOT NULL,
  "position_id"       uuid            NOT NULL,
  "market_id"         uuid            NOT NULL REFERENCES "trade"."markets" ("id"),
  "from_side"         text            NOT NULL,
  "size"              numeric(38, 18) NOT NULL,
  "leverage"          numeric(8, 2)   NOT NULL,
  "confirm_tier"      integer,
  "status"            text            NOT NULL DEFAULT 'closing',
  "close_order_id"    uuid,
  "open_order_id"     uuid,
  "closed_quantity"   numeric(38, 18),
  "opened_quantity"   numeric(38, 18),
  "new_position_id"   uuid,
  "refusal_code"      text,
  "open_sent_at"      timestamptz,
  "created_at"        timestamptz     NOT NULL DEFAULT now(),
  "updated_at"        timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT "futures_reverse_requests_request_uq" UNIQUE ("user_id", "client_request_id"),
  CONSTRAINT "futures_reverse_requests_side_ck" CHECK ("from_side" IN ('long', 'short')),
  CONSTRAINT "futures_reverse_requests_size_ck" CHECK ("size" > 0 AND "leverage" > 0),
  CONSTRAINT "futures_reverse_requests_status_ck" CHECK (
    "status" IN ('closing', 'opening', 'done', 'opened_part', 'closed_only', 'close_incomplete', 'refused')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "futures_reverse_requests_position_live_uq"
  ON "trade"."futures_reverse_requests" ("user_id", "position_id")
  WHERE "status" IN ('closing', 'opening');

-- The reconciler's read: the rows still working.
CREATE INDEX IF NOT EXISTS "futures_reverse_requests_working_idx"
  ON "trade"."futures_reverse_requests" ("updated_at")
  WHERE "status" IN ('closing', 'opening');
