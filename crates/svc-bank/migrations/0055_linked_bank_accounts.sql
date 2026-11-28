-- Linked bank accounts (BK-acct-02, J-bank-02 #6): the customer's own accounts at other banks, to pay in from and to
-- cash out to.
--
-- A linked account is kept as typed and starts `unverified`. Only a banking partner can prove the account exists and is
-- in the customer's name, so nothing in this build moves it to `verified`, and an unverified account is never used to
-- pay in or out. The IBAN is the business key: one active link per (customer, IBAN), so linking it again returns the
-- same account. Removing keeps the row with `removed_at`; linking it again later is a new account with a new
-- cooling-off window. This table holds no amount and is not a balance.
--
-- Reversal: 0055_linked_bank_accounts.down.sql

CREATE TABLE IF NOT EXISTS "bank"."linked_bank_accounts" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "label" text NOT NULL,
  "holder_name" text NOT NULL,
  "iban" text NOT NULL,
  "country" text NOT NULL,
  "state" text NOT NULL DEFAULT 'unverified',
  "verified_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "removed_at" timestamptz,
  CONSTRAINT "linked_bank_accounts_label_ck" CHECK (length("label") BETWEEN 1 AND 64),
  CONSTRAINT "linked_bank_accounts_holder_ck" CHECK (length("holder_name") BETWEEN 1 AND 140),
  CONSTRAINT "linked_bank_accounts_iban_ck" CHECK ("iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  CONSTRAINT "linked_bank_accounts_country_ck" CHECK ("country" = substr("iban", 1, 2)),
  CONSTRAINT "linked_bank_accounts_state_ck" CHECK (
    ("state" = 'unverified' AND "verified_at" IS NULL) OR ("state" = 'verified' AND "verified_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "linked_bank_accounts_active_iban_idx"
  ON "bank"."linked_bank_accounts" ("user_id", "iban") WHERE "removed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "linked_bank_accounts_user_idx"
  ON "bank"."linked_bank_accounts" ("user_id", "created_at");
