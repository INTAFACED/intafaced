-- Partner-held card authorisations (OWNER 226; B3's decision on project-state #1790, seam B). For a person whose money is
-- partner-held, the card partner holds an approved authorisation from the partner balance, and captures, releases and
-- refunds it, each once under a business key derived from the authorisation id. Our ledger posts nothing for it, so these
-- rows name the partner's reference instead of a ledger transaction. Every existing row is `ledger` (the default) and every
-- check that row already met still binds it exactly as before.

ALTER TABLE "bank"."card_authorizations"
  ADD COLUMN IF NOT EXISTS "money_book" text NOT NULL DEFAULT 'ledger',
  ADD COLUMN IF NOT EXISTS "partner_hold_ref" text,
  ADD COLUMN IF NOT EXISTS "partner_mode" text;

ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_money_book_known";
ALTER TABLE "bank"."card_authorizations" ADD CONSTRAINT "card_authorizations_money_book_known"
  CHECK ("money_book" IN ('ledger', 'partner'));

-- A partner-held row never names a ledger hold, and a ledger row never names a partner's.
ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_one_book";
ALTER TABLE "bank"."card_authorizations" ADD CONSTRAINT "card_authorizations_one_book"
  CHECK (
    ("money_book" = 'ledger' AND "partner_hold_ref" IS NULL AND "partner_mode" IS NULL)
    OR ("money_book" = 'partner' AND "hold_ledger_tx_id" IS NULL)
  );

ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_partner_mode_known";
ALTER TABLE "bank"."card_authorizations" ADD CONSTRAINT "card_authorizations_partner_mode_known"
  CHECK ("partner_mode" IS NULL OR "partner_mode" IN ('partner_holds', 'wallet_pull'));

-- 0017's rule, kept for the ledger and stated for the partner: a settled approval names what holds it.
ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_settled_approved_has_hold_ck";
ALTER TABLE "bank"."card_authorizations" ADD CONSTRAINT "card_authorizations_settled_approved_has_hold_ck"
  CHECK (
    "status" <> 'settled'
    OR "decision" <> 'approved'
    OR ("money_book" = 'ledger' AND "hold_ledger_tx_id" IS NOT NULL)
    OR ("money_book" = 'partner' AND "partner_hold_ref" IS NOT NULL AND "partner_mode" IS NOT NULL)
  );

ALTER TABLE "bank"."card_settlements"
  ADD COLUMN IF NOT EXISTS "money_book" text NOT NULL DEFAULT 'ledger',
  ADD COLUMN IF NOT EXISTS "partner_ref" text;

ALTER TABLE "bank"."card_settlements" DROP CONSTRAINT IF EXISTS "card_settlements_money_book_known";
ALTER TABLE "bank"."card_settlements" ADD CONSTRAINT "card_settlements_money_book_known"
  CHECK ("money_book" IN ('ledger', 'partner'));

ALTER TABLE "bank"."card_settlements" DROP CONSTRAINT IF EXISTS "card_settlements_one_book";
ALTER TABLE "bank"."card_settlements" ADD CONSTRAINT "card_settlements_one_book"
  CHECK (
    ("money_book" = 'ledger' AND "partner_ref" IS NULL)
    OR ("money_book" = 'partner' AND "ledger_tx_id" IS NULL)
  );

ALTER TABLE "bank"."card_settlements" DROP CONSTRAINT IF EXISTS "card_settlements_settled_has_tx_ck";
ALTER TABLE "bank"."card_settlements" ADD CONSTRAINT "card_settlements_settled_has_tx_ck"
  CHECK (
    "status" <> 'settled'
    OR ("money_book" = 'ledger' AND "ledger_tx_id" IS NOT NULL)
    OR ("money_book" = 'partner' AND "partner_ref" IS NOT NULL)
  );

-- A merchant's refund of a partner-held capture: one per authorisation, under `card.partner.refund:<authorisation>`. A
-- RECORD of the instruction and the partner's reference; the money is the partner's to move, and nothing posts here.
CREATE TABLE IF NOT EXISTS "bank"."card_partner_refunds" (
  "authorization_id" uuid PRIMARY KEY REFERENCES "bank"."card_authorizations" ("id"),
  "amount" numeric(38, 18) NOT NULL CHECK ("amount" > 0),
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "partner_ref" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "card_partner_refunds_settled_has_ref" CHECK ("status" <> 'settled' OR "partner_ref" IS NOT NULL)
);
