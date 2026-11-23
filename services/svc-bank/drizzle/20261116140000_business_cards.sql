-- A business gives its team cards and handles their expenses (J-bank-22; BK-bcard-01, BK-bexp-01, BK-bexp-02). The
-- business's money is the partner bank's (OWNER 226): a card purchase that is captured is one partner move from the
-- business's own account at the partner, and a reimbursement that is paid is one partner move from that account to the
-- member's own, each under its own key, stored here before it is sent and sent once. The card is a TEST card on the
-- TEST card network (`rail.card` is not connected): no card number, CVC or PIN exists anywhere. The ledger posts
-- nothing. These tables hold instructions, records and policies; never a balance.
--
-- Reversal: 20261116140000_business_cards.down.sql

-- A card the business gives one of its members, with the most one purchase may be.
CREATE TABLE IF NOT EXISTS "bank"."business_cards" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "member_user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "per_purchase_limit" numeric(38, 18) NOT NULL,
  -- The last four digits the member knows the card by; derived from the card id on the TEST card, which has no number.
  "pan_tail" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "issued_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_cards_status_ck" CHECK ("status" IN ('active', 'frozen')),
  CONSTRAINT "business_cards_limit_ck" CHECK ("per_purchase_limit" > 0),
  CONSTRAINT "business_cards_tail_ck" CHECK ("pan_tail" ~ '^[0-9]{4}$')
);
CREATE INDEX IF NOT EXISTS "business_cards_account_idx" ON "bank"."business_cards" ("account_id", "created_at");
CREATE INDEX IF NOT EXISTS "business_cards_member_idx" ON "bank"."business_cards" ("member_user_id");

-- One purchase on a business card, under its own id. Declined, it moves nothing and keeps its reason; captured, it is
-- one partner move under `bank.business.card-capture:<purchase id>`.
CREATE TABLE IF NOT EXISTS "bank"."business_card_purchases" (
  "id" uuid PRIMARY KEY,
  "card_id" uuid NOT NULL REFERENCES "bank"."business_cards" ("id"),
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "member_user_id" text NOT NULL,
  "merchant" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "status" text NOT NULL,
  "decline_reason" text,
  "partner_key" text NOT NULL UNIQUE,
  "partner_move_id" text,
  -- The business's receipt rule as it stood when the purchase was captured; null when the business had none.
  "receipt_over" numeric(38, 18),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "captured_at" timestamptz,
  CONSTRAINT "business_card_purchases_status_ck" CHECK ("status" IN ('declined', 'capturing', 'captured')),
  CONSTRAINT "business_card_purchases_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "business_card_purchases_key_ck" CHECK ("partner_key" = 'bank.business.card-capture:' || "id"::text),
  CONSTRAINT "business_card_purchases_decline_ck" CHECK (("status" = 'declined') = ("decline_reason" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "business_card_purchases_account_idx" ON "bank"."business_card_purchases" ("account_id", "created_at");

-- A member's request to the admins after a purchase over the card's limit was declined: one per declined purchase.
CREATE TABLE IF NOT EXISTS "bank"."business_card_limit_requests" (
  "purchase_id" uuid PRIMARY KEY REFERENCES "bank"."business_card_purchases" ("id"),
  "card_id" uuid NOT NULL REFERENCES "bank"."business_cards" ("id"),
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "member_user_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "decided_by" text,
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_card_limit_requests_status_ck" CHECK ("status" IN ('open', 'approved', 'declined')),
  CONSTRAINT "business_card_limit_requests_amount_ck" CHECK ("amount" > 0)
);

-- The business's own expense policy: a captured purchase over `receipt_over` needs a receipt.
CREATE TABLE IF NOT EXISTS "bank"."business_expense_policies" (
  "account_id" uuid PRIMARY KEY REFERENCES "bank"."business_accounts" ("id"),
  "receipt_over" numeric(38, 18) NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_expense_policies_over_ck" CHECK ("receipt_over" >= 0)
);

-- A receipt file a member gave for a purchase or a reimbursement claim.
CREATE TABLE IF NOT EXISTS "bank"."business_receipts" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "uploaded_by" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "bytes" bytea NOT NULL,
  "sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_receipts_sha_ck" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "business_receipts_size_ck" CHECK (octet_length("bytes") BETWEEN 1 AND 524288)
);
CREATE INDEX IF NOT EXISTS "business_receipts_account_idx" ON "bank"."business_receipts" ("account_id", "created_at");

-- Which receipt a captured purchase has, once the member gives one.
CREATE TABLE IF NOT EXISTS "bank"."business_purchase_receipts" (
  "purchase_id" uuid PRIMARY KEY REFERENCES "bank"."business_card_purchases" ("id"),
  "receipt_id" uuid NOT NULL REFERENCES "bank"."business_receipts" ("id"),
  "attached_at" timestamptz NOT NULL DEFAULT now()
);

-- The one reminder queued for a captured purchase that needs a receipt and has none: one per purchase, never more.
CREATE TABLE IF NOT EXISTS "bank"."business_receipt_reminders" (
  "purchase_id" uuid PRIMARY KEY REFERENCES "bank"."business_card_purchases" ("id"),
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "member_user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "queued_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_receipt_reminders_status_ck" CHECK ("status" IN ('queued', 'cleared'))
);

-- A member's claim to be paid back what they spent from their own money, with its receipt. Approved and paid, it is one
-- partner move from the business's account to the member's own, under `bank.business.reimbursement:<claim id>`.
CREATE TABLE IF NOT EXISTS "bank"."business_reimbursements" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "member_user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "description" text NOT NULL,
  "receipt_id" uuid NOT NULL REFERENCES "bank"."business_receipts" ("id"),
  "status" text NOT NULL DEFAULT 'submitted',
  "approved_by" text,
  "partner_key" text NOT NULL UNIQUE,
  "partner_move_id" text,
  -- The member's balance at the partner as it reported it just before the move and just after; null when not reported.
  "member_before" numeric(38, 18),
  "member_after" numeric(38, 18),
  "refusal_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "paid_at" timestamptz,
  CONSTRAINT "business_reimbursements_status_ck" CHECK ("status" IN ('submitted', 'paying', 'paid', 'declined')),
  CONSTRAINT "business_reimbursements_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "business_reimbursements_key_ck" CHECK ("partner_key" = 'bank.business.reimbursement:' || "id"::text)
);
CREATE INDEX IF NOT EXISTS "business_reimbursements_account_idx" ON "bank"."business_reimbursements" ("account_id", "created_at");
