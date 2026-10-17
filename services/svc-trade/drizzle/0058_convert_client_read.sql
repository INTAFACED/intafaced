-- trade.convert · client id and stored refusal for history/status reads
-- Reversal: 0058_convert_client_read.down.sql
--
-- convert.status looks up the caller's quote by clientConvertId. A refused
-- accept keeps lifecycle `open` (retry is still the same quote) and records
-- the refusal code here so the read can say `refused` without scanning the ledger.

ALTER TABLE "trade"."convert_quotes"
  ADD COLUMN IF NOT EXISTS "client_convert_id" text,
  ADD COLUMN IF NOT EXISTS "refusal_code" text;

CREATE UNIQUE INDEX IF NOT EXISTS "convert_quotes_user_client_idx"
  ON "trade"."convert_quotes" ("user_id", "client_convert_id")
  WHERE "client_convert_id" IS NOT NULL;
