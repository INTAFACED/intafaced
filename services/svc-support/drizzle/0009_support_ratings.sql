-- svc-support · owner close receipts and one rating per ticket
-- Reversal: 0009_support_ratings.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds two tables. It drops no table,
-- no column, and no row.
--
-- write_receipts is the idempotency record for owner writes (close, rate,
-- attach, kb feedback). A replay reads the first result and writes nothing
-- else. Ratings are unique per ticket. No amount, balance, or currency column.

CREATE TABLE IF NOT EXISTS "support"."write_receipts" (
  "procedure"          text NOT NULL,
  "actor_id"           text NOT NULL,
  "client_request_id"  text NOT NULL,
  "result"             jsonb NOT NULL,
  PRIMARY KEY ("procedure", "actor_id", "client_request_id")
);

ALTER TABLE "support"."write_receipts" DROP CONSTRAINT IF EXISTS "write_receipts_request_len_ck";
ALTER TABLE "support"."write_receipts" ADD CONSTRAINT "write_receipts_request_len_ck"
  CHECK (char_length("client_request_id") BETWEEN 1 AND 200);

CREATE TABLE IF NOT EXISTS "support"."ticket_ratings" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_id"          uuid NOT NULL UNIQUE REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "user_id"            text NOT NULL,
  "score"              integer NOT NULL,
  "note"               text,
  "client_request_id"  text NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "support"."ticket_ratings" DROP CONSTRAINT IF EXISTS "ticket_ratings_score_ck";
ALTER TABLE "support"."ticket_ratings" ADD CONSTRAINT "ticket_ratings_score_ck"
  CHECK ("score" BETWEEN 1 AND 5);

ALTER TABLE "support"."ticket_ratings" DROP CONSTRAINT IF EXISTS "ticket_ratings_note_len_ck";
ALTER TABLE "support"."ticket_ratings" ADD CONSTRAINT "ticket_ratings_note_len_ck"
  CHECK ("note" IS NULL OR char_length("note") <= 500);

ALTER TABLE "support"."ticket_ratings" DROP CONSTRAINT IF EXISTS "ticket_ratings_request_len_ck";
ALTER TABLE "support"."ticket_ratings" ADD CONSTRAINT "ticket_ratings_request_len_ck"
  CHECK (char_length("client_request_id") BETWEEN 1 AND 200);
