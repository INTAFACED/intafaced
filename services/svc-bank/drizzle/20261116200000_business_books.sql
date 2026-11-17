-- A business keeps its books in order (J-bank-23; BK-bexp-03, BK-bexp-04, BK-bexp-05). The business's money and its
-- lines are the partner bank's (OWNER 226): every line here is one line of the partner's own record for the business's
-- account, named by the partner's reference. These tables hold the business's own bookkeeping about those lines (a
-- category, a GL code, the rule that set them) and the record of an accounting connection asked for. Never an amount and
-- never a balance: a statement reads both from the partner.
--
-- Reversal: 20261116200000_business_books.down.sql

-- An accounting connection the business asked for. No accounting software is connected in this build
-- (`vendor.accounting`), so it is kept switched off, with who asked and when, and how many times.
CREATE TABLE IF NOT EXISTS "bank"."business_accounting_connections" (
  "account_id" uuid PRIMARY KEY REFERENCES "bank"."business_accounts" ("id"),
  "status" text NOT NULL,
  "needs" text NOT NULL,
  "requested_by" text NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "attempts" integer NOT NULL DEFAULT 1,
  CONSTRAINT "business_accounting_connections_status_ck" CHECK ("status" IN ('switched_off')),
  CONSTRAINT "business_accounting_connections_attempts_ck" CHECK ("attempts" >= 1)
);

-- The business's coding rules: a line whose payee contains the text gets the category (and GL code).
CREATE TABLE IF NOT EXISTS "bank"."business_coding_rules" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "payee_contains" text NOT NULL,
  "category" text NOT NULL,
  "gl_code" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_coding_rules_text_ck" CHECK (length("payee_contains") BETWEEN 1 AND 80 AND length("category") BETWEEN 1 AND 60)
);
CREATE INDEX IF NOT EXISTS "business_coding_rules_account_idx" ON "bank"."business_coding_rules" ("account_id", "created_at");

-- How one line of the partner's record is coded: by a rule or by a person. One row per line.
CREATE TABLE IF NOT EXISTS "bank"."business_line_codes" (
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "line_id" text NOT NULL,
  "category" text,
  "gl_code" text,
  "coded_by" text NOT NULL,
  "rule_id" uuid REFERENCES "bank"."business_coding_rules" ("id"),
  "coded_by_user" text,
  "coded_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "line_id"),
  CONSTRAINT "business_line_codes_by_ck" CHECK (
    ("coded_by" = 'rule' AND "rule_id" IS NOT NULL) OR ("coded_by" = 'person' AND "coded_by_user" IS NOT NULL)
  ),
  CONSTRAINT "business_line_codes_some_ck" CHECK ("category" IS NOT NULL OR "gl_code" IS NOT NULL)
);
