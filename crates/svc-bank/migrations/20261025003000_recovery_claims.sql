-- Recovery claims (RC-identity-08, J-identity-05 #7): the heir an owner named claims the owner's balances after two
-- staff confirmed a death notice, with signatures from the owner's own recovery keys. Identity decides whether a claim
-- may go ahead (the notice, the heir, the keys); the bank keeps only the claim and its sweep plan. A sweep row is the
-- plan for one ledger account in one round, written before anything posts, so a crash between the plan and the ledger
-- is resumed with the same business key and never posts twice. The amount is what that round moves; the balance stays
-- the ledger's answer. Value that arrives after a round is swept by the next round.
-- Reversal: the matching .down.sql

CREATE TABLE IF NOT EXISTS "bank"."recovery_claims" (
  "id" uuid PRIMARY KEY,
  -- One claim per account: asking again answers the same claim.
  "owner_user_id" text NOT NULL CONSTRAINT "recovery_claims_owner_uq" UNIQUE,
  "heir_user_id" text NOT NULL,
  -- The confirmed death notice identity named when the claim was opened.
  "notice_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'open' CONSTRAINT "recovery_claims_status_ck" CHECK ("status" IN ('open', 'executed')),
  -- The next round to plan. Round r's sweeps all settle before round r + 1 is planned.
  "round" integer NOT NULL DEFAULT 0 CONSTRAINT "recovery_claims_round_ck" CHECK ("round" >= 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "executed_at" timestamptz,
  CONSTRAINT "recovery_claims_heir_ck" CHECK ("heir_user_id" <> "owner_user_id"),
  CONSTRAINT "recovery_claims_executed_ck" CHECK (("status" = 'executed') = ("executed_at" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "recovery_claims_heir_idx" ON "bank"."recovery_claims" ("heir_user_id");

CREATE TABLE IF NOT EXISTS "bank"."recovery_sweeps" (
  "claim_id" uuid NOT NULL REFERENCES "bank"."recovery_claims" ("id"),
  "round" integer NOT NULL,
  -- The ledger account swept, as ledger-client's accountKey names it.
  "account_key" text NOT NULL,
  "from_owner_type" text NOT NULL CONSTRAINT "recovery_sweeps_owner_type_ck" CHECK ("from_owner_type" IN ('user', 'subaccount')),
  "from_owner_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL CONSTRAINT "recovery_sweeps_amount_ck" CHECK ("amount" > 0),
  -- bank.transfer.recovery:<claim>:<account>:<round>, the key the ledger post carries.
  "idempotency_key" text NOT NULL CONSTRAINT "recovery_sweeps_key_uq" UNIQUE,
  "status" text NOT NULL DEFAULT 'pending' CONSTRAINT "recovery_sweeps_status_ck" CHECK ("status" IN ('pending', 'posted', 'refused')),
  "ledger_tx_id" text,
  "refusal_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  PRIMARY KEY ("claim_id", "round", "account_key"),
  CONSTRAINT "recovery_sweeps_settled_ck" CHECK (
    ("status" = 'pending' AND "settled_at" IS NULL AND "ledger_tx_id" IS NULL AND "refusal_code" IS NULL)
    OR ("status" = 'posted' AND "settled_at" IS NOT NULL AND "ledger_tx_id" IS NOT NULL AND "refusal_code" IS NULL)
    OR ("status" = 'refused' AND "settled_at" IS NOT NULL AND "ledger_tx_id" IS NULL AND "refusal_code" IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS "recovery_sweeps_pending_idx" ON "bank"."recovery_sweeps" ("claim_id") WHERE "status" = 'pending';
