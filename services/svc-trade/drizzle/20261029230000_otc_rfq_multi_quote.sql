-- trade.otc · one request asks several providers (J-copy-bots-otc-24 #5): each quote names its request, its place in
-- it and the provider that quoted; a quote priced at a LOCAL TEST spread is marked test. At most one quote of a request
-- is ever bound or settled.
-- Reversal: 20261029230000_otc_rfq_multi_quote.down.sql
-- A quote saved before this has no request id: it is its own request (rfq_id = quote_id when read).

ALTER TABLE "trade"."otc_desk_quotes"
  ADD COLUMN IF NOT EXISTS "rfq_id" text;

ALTER TABLE "trade"."otc_desk_quotes"
  ADD COLUMN IF NOT EXISTS "rfq_seq" integer NOT NULL DEFAULT 1;

ALTER TABLE "trade"."otc_desk_quotes"
  ADD COLUMN IF NOT EXISTS "maker_id" text;

ALTER TABLE "trade"."otc_desk_quotes"
  ADD COLUMN IF NOT EXISTS "test" boolean NOT NULL DEFAULT false;

ALTER TABLE "trade"."otc_desk_quotes"
  DROP CONSTRAINT IF EXISTS "otc_desk_quotes_rfq_seq_ck";

ALTER TABLE "trade"."otc_desk_quotes"
  ADD CONSTRAINT "otc_desk_quotes_rfq_seq_ck" CHECK ("rfq_seq" >= 1);

CREATE INDEX IF NOT EXISTS "otc_desk_quotes_rfq_idx"
  ON "trade"."otc_desk_quotes" ("rfq_id")
  WHERE "rfq_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "otc_desk_quotes_one_accept_per_rfq_ux"
  ON "trade"."otc_desk_quotes" ("rfq_id")
  WHERE "rfq_id" IS NOT NULL AND "lifecycle" IN ('bound', 'settled');
