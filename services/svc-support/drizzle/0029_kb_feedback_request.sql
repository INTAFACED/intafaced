-- svc-support · article feedback comment, the request it opens, and search logs (SP-kb-03)
-- Reversal: 0029_kb_feedback_request.down.sql
--
-- NOT tagged `intafaced:destructive`. It adds nullable columns and two tables.
-- It drops no table, no column, and no row. It seeds nothing.
--
-- A search miss stores the query text, a zero count and the time. It has no
-- reader column. A click stores the query, the article id and the caller's
-- request id. It has no reader column either.

ALTER TABLE "support"."kb_feedback" ADD COLUMN IF NOT EXISTS "comment" text;
ALTER TABLE "support"."kb_feedback" ADD COLUMN IF NOT EXISTS "ticket_id" uuid;

ALTER TABLE "support"."kb_feedback" DROP CONSTRAINT IF EXISTS "kb_feedback_comment_len_ck";
ALTER TABLE "support"."kb_feedback" ADD CONSTRAINT "kb_feedback_comment_len_ck"
  CHECK ("comment" IS NULL OR char_length("comment") BETWEEN 1 AND 2000);

ALTER TABLE "support"."kb_feedback" DROP CONSTRAINT IF EXISTS "kb_feedback_ticket_fk";
ALTER TABLE "support"."kb_feedback" ADD CONSTRAINT "kb_feedback_ticket_fk"
  FOREIGN KEY ("ticket_id") REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS "kb_feedback_reader_at_idx"
  ON "support"."kb_feedback" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "support"."kb_search_misses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "query" text NOT NULL,
  "result_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kb_search_misses_query_len_ck" CHECK (char_length("query") BETWEEN 1 AND 200),
  CONSTRAINT "kb_search_misses_count_ck" CHECK ("result_count" = 0)
);

CREATE TABLE IF NOT EXISTS "support"."kb_search_clicks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "query" text NOT NULL,
  "article_id" text NOT NULL,
  "client_request_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kb_search_clicks_query_len_ck" CHECK (char_length("query") BETWEEN 1 AND 200),
  CONSTRAINT "kb_search_clicks_request_len_ck" CHECK (char_length("client_request_id") BETWEEN 1 AND 200),
  CONSTRAINT "kb_search_clicks_request_uq" UNIQUE ("client_request_id")
);
