DROP TABLE IF EXISTS "support"."kb_search_clicks";
DROP TABLE IF EXISTS "support"."kb_search_misses";

ALTER TABLE "support"."kb_feedback" DROP CONSTRAINT IF EXISTS "kb_feedback_ticket_fk";
ALTER TABLE "support"."kb_feedback" DROP CONSTRAINT IF EXISTS "kb_feedback_comment_len_ck";
DROP INDEX IF EXISTS "support"."kb_feedback_reader_at_idx";
ALTER TABLE "support"."kb_feedback" DROP COLUMN IF EXISTS "ticket_id";
ALTER TABLE "support"."kb_feedback" DROP COLUMN IF EXISTS "comment";
