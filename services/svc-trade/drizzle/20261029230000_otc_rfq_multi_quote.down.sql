-- Reverse 20261029230000_otc_rfq_multi_quote.sql
DROP INDEX IF EXISTS "trade"."otc_desk_quotes_one_accept_per_rfq_ux";
DROP INDEX IF EXISTS "trade"."otc_desk_quotes_rfq_idx";
ALTER TABLE "trade"."otc_desk_quotes" DROP CONSTRAINT IF EXISTS "otc_desk_quotes_rfq_seq_ck";
ALTER TABLE "trade"."otc_desk_quotes" DROP COLUMN IF EXISTS "test";
ALTER TABLE "trade"."otc_desk_quotes" DROP COLUMN IF EXISTS "maker_id";
ALTER TABLE "trade"."otc_desk_quotes" DROP COLUMN IF EXISTS "rfq_seq";
ALTER TABLE "trade"."otc_desk_quotes" DROP COLUMN IF EXISTS "rfq_id";
