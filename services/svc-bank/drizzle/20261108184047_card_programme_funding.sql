-- J-bank-26 #6 (BK-cops-05): each programme funding instruction an operator pair sent to the card partner: fund or defund
-- an amount of the funding stablecoin, or set auto reload. A RECORD of one instruction and the partner's reference, written
-- once under its business key (the approved operation's client request id). The money is the partner's to move, under its
-- licence (OWNER 226): nothing posts to the ledger with it, and nothing here is summed into a balance.
CREATE TABLE IF NOT EXISTS "bank"."card_programme_funding_requests" (
  "client_request_id" text PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('fund', 'defund', 'auto_reload')),
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL CHECK ("amount" > 0),
  "threshold" numeric(38, 18) CHECK ("threshold" IS NULL OR "threshold" > 0),
  "reason" text NOT NULL,
  "partner_ref" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_programme_funding_threshold_only_reload" CHECK (("kind" = 'auto_reload') = ("threshold" IS NOT NULL))
);
