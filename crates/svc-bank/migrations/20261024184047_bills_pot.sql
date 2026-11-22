-- Bills pot (BK-pots-03, J-bank-07 #4): one of the person's own named spaces, per asset, that pays their bills. A
-- standing order from it that finds too little money can top the pot up from the main account first, but only when the
-- person turned that fallback on. A role on a space, never a balance: the top-up is an own-space bankTransfer.

CREATE TABLE IF NOT EXISTS "bank"."bills_pots" (
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  -- Off unless the person turns it on: then a shortfall moves from the main account into the pot before the payment.
  "fallback" boolean NOT NULL DEFAULT false,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "asset_id"),
  CONSTRAINT "bills_pots_space_uq" UNIQUE ("space_id")
);
