-- intafaced:destructive forgets which rate lock each global send was confirmed on, and every lock; a send keeps the quote figures it was paid at (quote_rate, quote_receive and the rest)
DROP INDEX IF EXISTS "bank"."global_sends_quote_uq";
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "quote_id";
DROP INDEX IF EXISTS "bank"."global_quotes_user_idx";
DROP TABLE IF EXISTS "bank"."global_quotes";
