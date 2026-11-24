-- svc-bank — CARDS (§8.1), THE LEDGER HALF ONLY
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT CREATE: A CARD PROGRAMME
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `bank.cards` splits cleanly in two and the halves fail for unrelated reasons.
--
-- The half below is arithmetic over accounts this platform already owns: an
-- authorisation arrives, the ledger is asked whether the money is there, funds
-- are held or the authorisation is declined, a capture takes the value out and
-- cashback pays some of it back. Nothing in the world is missing. It is built.
--
-- The other half needs a card-scheme sponsor and an issuing BIN — a licence and
-- a contract, which no amount of engineering time produces. That is the §13
-- test, and it lands on `socket.live-issuer`. `src/cards/issuer.ts` is the seam
-- between the two and says at length what is on each side of it.
--
-- So every card these tables can hold is `simulated = true`, and the column is
-- NOT NULL with that default on purpose: a row has to outlive the composition
-- root that made it and still be able to say whether it was ever real.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AND NO BALANCE. NOT EVEN THE TEMPTING ONE.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The tempting column here is `spendable`, or `available_credit`, or a
-- `remaining_daily_limit` that counts down. None of them exist and none can.
-- What a card may spend is the user's ledger balance less whatever is held
-- against open authorisations, and BOTH halves are ledger reads: each
-- authorisation holds into `user/<id>/<asset>/hold/withdraw:<authId>`, its own
-- account, so "what is currently held on this card" is a sum svc-ledger already
-- knows. Mirroring it here would be a second source of truth for the number that
-- decides whether somebody's payment goes through at a till.
--
-- `per_authorization_limit` is a CEILING, not an allowance. It does not fall as
-- the card is used; nothing writes it after insert. A per-period allowance would
-- be a running total wearing a policy's clothes, and `bank-service.test.ts`
-- fails the build on money columns that are not declared and reasoned.

-- active  the card may authorise
-- frozen  the user or an operator stopped it; authorisations DECLINE, they do
--         not queue — a frozen card that silently held funds would be worse
--         than one that says no
-- closed  terminal
DO $$ BEGIN
  CREATE TYPE "bank"."card_status" AS ENUM ('active', 'frozen', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A decline is an OUTCOME, not an error. It gets a row like an approval does,
-- because "why was I declined" is a question a user asks days later.
DO $$ BEGIN
  CREATE TYPE "bank"."card_decision" AS ENUM ('approved', 'declined');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- capture   value leaves the book at the rail boundary
-- reversal  the unspent part of a hold goes back to the user
DO $$ BEGIN
  CREATE TYPE "bank"."card_settlement_kind" AS ENUM ('capture', 'reversal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reuses `bank.loan_event_status` (pending/settled/rejected) rather than
-- declaring a fourth identical enum. `pending` is a claim written before a
-- ledger post, and it means the same thing here as it does on a repayment.

-- ─────────────────────────────────────────────────────────────────────────────
-- A CARD — an issuer handle, a name, and two policy numbers.
--
-- A DEBIT instrument over an account the user already has. There is no credit
-- line, so there is no exposure to track and no limit that counts down.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  -- Which of the user's balances this card draws on.
  "asset_id" text NOT NULL,
  -- Programme id, which is ALSO the ledger rail label, so the boundary account
  -- `rail/card-sim/<asset>` and the rows that produced it share one string.
  "issuer" text NOT NULL,
  -- FALSE WOULD MEAN A REAL CARD EXISTS. Nothing sets it false today.
  "simulated" boolean NOT NULL DEFAULT true,
  "issuer_ref" text NOT NULL,
  -- Four digits a human recognises the card by. NOT a card number and not part
  -- of one — on a simulated programme it is derived from the card's uuid. This
  -- service never sees, stores or transmits a PAN, and has no column for one.
  "pan_tail" text NOT NULL,
  "status" "bank"."card_status" NOT NULL DEFAULT 'active',
  -- POLICY: the rate the card was issued on, snapshotted onto each cashback row
  -- so a later re-rating cannot rewrite what was already promised.
  "cashback_bps" integer NOT NULL DEFAULT 0,
  -- POLICY: the largest SINGLE authorisation this card may approve. A ceiling.
  -- No money path writes it.
  "per_authorization_limit" numeric(38, 18) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "cards_limit_positive" CHECK ("per_authorization_limit" > 0),
  CONSTRAINT "cards_cashback_bounded" CHECK ("cashback_bps" >= 0 AND "cashback_bps" <= 10000),
  CONSTRAINT "cards_pan_tail_shape" CHECK ("pan_tail" ~ '^[0-9]{4}$')
);

-- One card row per issuer handle. A redelivered issue callback finds this one
-- rather than opening a second card against the same user's balance.
CREATE UNIQUE INDEX IF NOT EXISTS "cards_issuer_ref_idx" ON "bank"."cards" ("issuer", "issuer_ref");
CREATE INDEX IF NOT EXISTS "cards_user_status_idx" ON "bank"."cards" ("user_id", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- ONE AUTHORISATION — the decision, recorded whichever way it went.
--
-- `unique(card_id, authorization_ref)` is the double-decide guard, and it is the
-- same shape and the same reasoning as `transfer_executions`: an issuer WILL
-- redeliver, and the second delivery must return the first decision rather than
-- place a second hold on one purchase. The ledger's own key
-- `withdraw.hold:<authorization uuid>` is the second line of defence.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."card_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "card_id" uuid NOT NULL REFERENCES "bank"."cards" ("id"),
  "authorization_ref" text NOT NULL,
  -- What the merchant asked for. A RECORD of one request, written once.
  "amount" numeric(38, 18) NOT NULL,
  -- A category label for the user's own statement. Never a merchant's brand
  -- name and never a partner's (§0.7).
  "merchant_category" text,
  "decision" "bank"."card_decision" NOT NULL,
  -- The named reason, e.g. 'bank.card_not_active'. NULL when approved, and the
  -- CHECK below makes that agreement structural rather than a convention.
  "decline_code" text,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  -- The hold. NULL on a decline, because a decline moves nothing.
  "hold_ledger_tx_id" text,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,

  CONSTRAINT "card_authorizations_amount_positive" CHECK ("amount" > 0),
  -- An approval with a decline reason on it, or a decline with none, is a row
  -- nobody can act on. The database refuses both.
  CONSTRAINT "card_authorizations_reason_matches_decision" CHECK (
    ("decision" = 'approved' AND "decline_code" IS NULL)
    OR ("decision" = 'declined' AND "decline_code" IS NOT NULL)
  ),
  -- A decline never posts, so it can never carry a ledger transaction.
  CONSTRAINT "card_authorizations_decline_moves_nothing" CHECK (
    "decision" = 'approved' OR "hold_ledger_tx_id" IS NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "card_authorizations_ref_idx"
  ON "bank"."card_authorizations" ("card_id", "authorization_ref");
CREATE INDEX IF NOT EXISTS "card_authorizations_card_idx" ON "bank"."card_authorizations" ("card_id", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- A CAPTURE OR A REVERSAL — one completed movement against one authorisation.
--
-- Keyed on (authorization, sequence) rather than on the authorisation alone,
-- because a PARTIAL capture produces both rows in one pass: the merchant takes
-- what they charged, and the unspent remainder of the hold goes straight back to
-- the user. Two facts, two rows, two ledger transaction ids.
--
-- The pair is also exhaustive by construction. `withdraw_hold` puts the whole
-- authorised amount into an account of its own, so after a capture that account
-- must read zero — capture + reversal = authorised — and the test asserts it on
-- the ACCOUNT, not on these rows, because the ledger is the one that has to be
-- right.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."card_settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorization_id" uuid NOT NULL REFERENCES "bank"."card_authorizations" ("id"),
  "sequence" integer NOT NULL,
  "kind" "bank"."card_settlement_kind" NOT NULL,
  -- A RECORD of one completed movement; written once with its ledger tx id.
  "amount" numeric(38, 18) NOT NULL,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,

  CONSTRAINT "card_settlements_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "card_settlements_seq_idx"
  ON "bank"."card_settlements" ("authorization_id", "sequence");
CREATE INDEX IF NOT EXISTS "card_settlements_auth_idx" ON "bank"."card_settlements" ("authorization_id", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- CASHBACK ON ONE CAPTURE.
--
-- Its own table and its own status, so a reward that could not be paid is
-- VISIBLE as an unpaid reward rather than as an absence. Cashback is paid out of
-- the rewards engine, funded from real bank revenue, and that pot can be empty.
--
-- When it is: the capture still stands and this row is `rejected` carrying
-- 'bank.cashback_pot_unfunded'. The two designs this rejects are worse in
-- opposite directions — swallowing the failure leaves a user quietly unpaid and
-- an operator with nothing to look at, while failing the capture would undo a
-- purchase that already happened because a marketing promise could not be kept.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."card_cashback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorization_id" uuid NOT NULL REFERENCES "bank"."card_authorizations" ("id"),
  -- Snapshotted, so re-rating the card later cannot rewrite what was promised.
  "rate_bps" integer NOT NULL,
  -- A RECORD of one reward; summing the table is the lifetime figure.
  "amount" numeric(38, 18) NOT NULL,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,

  CONSTRAINT "card_cashback_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "card_cashback_rate_bounded" CHECK ("rate_bps" > 0 AND "rate_bps" <= 10000)
);

-- ONE CASHBACK PER AUTHORISATION, forever.
CREATE UNIQUE INDEX IF NOT EXISTS "card_cashback_auth_idx" ON "bank"."card_cashback" ("authorization_id");
CREATE INDEX IF NOT EXISTS "card_cashback_status_idx" ON "bank"."card_cashback" ("status");
