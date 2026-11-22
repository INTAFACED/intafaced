-- svc-bank · a card added to a phone wallet (J-bank-14 #4)
-- Reversal: 20261109094420_card_wallet_tokens.down.sql
--
-- One row per card and wallet: the card was added to that wallet through the issuer. The issuer's payload is never kept.
-- Adding the same card to the same wallet again returns the row already there. The row's state is 'added'; a reader shows
-- it paused while the card is frozen, from the card's own status, so a freeze needs no second write. Nothing here is a
-- balance and no value moves.

CREATE TABLE IF NOT EXISTS "bank"."card_wallet_tokens" (
  "id"          uuid PRIMARY KEY,
  "card_id"     uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "user_id"     text NOT NULL,
  "wallet"      text NOT NULL,
  "state"       text NOT NULL DEFAULT 'added',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_wallet_tokens_wallet_ck" CHECK ("wallet" IN ('apple', 'google')),
  CONSTRAINT "card_wallet_tokens_state_ck" CHECK ("state" IN ('added'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_wallet_tokens_card_wallet_uq" ON "bank"."card_wallet_tokens" ("card_id", "wallet");
