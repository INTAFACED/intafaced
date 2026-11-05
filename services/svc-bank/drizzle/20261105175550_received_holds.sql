-- PP-money-balance-05 (J-pay-03 #5): how a person treats payments from people not in their contacts, and the payments
-- held for them to accept. A hold row is the decision and the state of one ledger hold on received funds
-- (`payReceivedHold` / `Release` / `Return`, keys `pay.recv.hold|release|return:<transfer_id>`); the money is only ever in
-- the ledger, and the amount is the instruction the hold was placed for, written once and never summed.
CREATE TABLE IF NOT EXISTS "bank"."receive_rules" (
  "user_id" text PRIMARY KEY,
  "strangers" text NOT NULL DEFAULT 'pay_in',
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "receive_rules_strangers_ck" CHECK ("strangers" IN ('pay_in', 'hold'))
);

CREATE TABLE IF NOT EXISTS "bank"."received_holds" (
  -- The send's own id: one hold per payment. An abandoned reservation is deleted, and its decision with it.
  "transfer_id" text PRIMARY KEY REFERENCES "bank"."personal_transfers" ("transfer_id") ON DELETE CASCADE,
  "recipient_user_id" text NOT NULL,
  "payer_user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  -- Why it is held, as a class the person is shown; never free text.
  "reason_class" text NOT NULL,
  "state" text NOT NULL DEFAULT 'placing',
  -- When an unanswered hold goes back to the payer: the owner's period from the day it was placed.
  "release_at" timestamptz NOT NULL,
  "hold_tx_id" text,
  "outcome_tx_id" text,
  -- The recipient's id, or `system:release-date`.
  "decided_by" text,
  "lapse_reason" text,
  "attempted_at" timestamptz,
  -- When the ledger first refused the hold for want of funds, with no attempt of unknown outcome since.
  "refused_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "placed_at" timestamptz,
  "decided_at" timestamptz,
  CONSTRAINT "received_holds_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "received_holds_parties_ck" CHECK ("recipient_user_id" <> "payer_user_id"),
  CONSTRAINT "received_holds_reason_ck" CHECK ("reason_class" IN ('stranger')),
  CONSTRAINT "received_holds_state_ck" CHECK (
    "state" IN ('placing', 'held', 'releasing', 'released', 'returning', 'returned', 'lapsed')
  ),
  CONSTRAINT "received_holds_steps_ck" CHECK (
    ("state" = 'placing' AND "hold_tx_id" IS NULL AND "outcome_tx_id" IS NULL AND "decided_by" IS NULL)
    OR ("state" = 'lapsed' AND "hold_tx_id" IS NULL AND "outcome_tx_id" IS NULL AND "decided_at" IS NOT NULL)
    OR ("state" = 'held' AND "hold_tx_id" IS NOT NULL AND "outcome_tx_id" IS NULL AND "decided_by" IS NULL)
    OR ("state" IN ('releasing', 'returning') AND "hold_tx_id" IS NOT NULL AND "outcome_tx_id" IS NULL AND "decided_by" IS NOT NULL)
    OR ("state" IN ('released', 'returned') AND "hold_tx_id" IS NOT NULL AND "outcome_tx_id" IS NOT NULL
        AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "received_holds_recipient_idx"
  ON "bank"."received_holds" ("recipient_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "received_holds_open_idx"
  ON "bank"."received_holds" ("created_at")
  WHERE "state" IN ('placing', 'held', 'releasing', 'returning');
