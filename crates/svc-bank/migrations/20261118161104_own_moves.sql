-- Moves between a person's own spending and trading accounts (J-derivatives-25 #2, BK-ownmove-01). A move in is the
-- partner bank's transfer from the person's main balance to their own wallet, then the wallet's own signed deposit to
-- their venue account. The partner and the venue hold the money and its record, and the ledger posts nothing. A row
-- records only what the person asked for, under its business key, and each leg's reference once it is known.
--
-- Reversal: the matching .down.sql

CREATE TABLE IF NOT EXISTS "bank"."own_moves" (
  -- The person's own id for the move: asking again with it is the same move, never a second.
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  -- in: spending to trading.
  "direction" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  -- The person's own wallet the partner sends to, lowercase; it signed this move's message.
  "wallet" text NOT NULL,
  -- opening: kept, the partner not yet asked; sent: the partner moved it and its transfer to the wallet is on chain.
  "status" text NOT NULL,
  -- The partner's reference for the move out of the main balance, and its on-chain transfer to the wallet.
  "partner_ref" text,
  "delivery_tx" text,
  -- The wallet's own transfer to the venue's deposit address, once the person signed it.
  "deposit_tx" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  "deposit_at" timestamptz,
  CONSTRAINT "own_moves_direction_ck" CHECK ("direction" IN ('in')),
  CONSTRAINT "own_moves_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "own_moves_status_ck" CHECK ("status" IN ('opening', 'sent')),
  CONSTRAINT "own_moves_sent_ck" CHECK (("status" = 'sent') = ("partner_ref" IS NOT NULL AND "delivery_tx" IS NOT NULL AND "sent_at" IS NOT NULL)),
  CONSTRAINT "own_moves_deposit_ck" CHECK (("deposit_tx" IS NULL) = ("deposit_at" IS NULL)),
  CONSTRAINT "own_moves_deposit_after_sent_ck" CHECK ("deposit_tx" IS NULL OR "status" = 'sent')
);

CREATE INDEX IF NOT EXISTS "own_moves_user_idx" ON "bank"."own_moves" ("user_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "own_moves_deposit_tx_uq" ON "bank"."own_moves" ("deposit_tx") WHERE "deposit_tx" IS NOT NULL;

COMMENT ON COLUMN "bank"."own_moves"."amount" IS 'money: an INSTRUCTION: one move between the person''s own partner account and wallet under its id; the partner and the venue record the money';
