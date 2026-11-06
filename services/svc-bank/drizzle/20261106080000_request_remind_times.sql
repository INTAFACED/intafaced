-- J-pay-05 #4 (PP-send-request-13): when each reminder of a request was sent, so the owner's reminder terms can count the
-- reminders in a window. Rows written before this have the migration's time, which only ever counts them as recent.
ALTER TABLE "bank"."personal_request_reminds"
  ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "personal_request_reminds_time_idx"
  ON "bank"."personal_request_reminds" ("request_id", "created_at");
