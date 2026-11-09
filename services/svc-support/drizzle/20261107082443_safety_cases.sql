-- svc-support · complaints and bereavement reports, each acknowledged once (BK-safe-03, J-bank-18 #5 #6)
-- Reversal: 20261107082443_safety_cases.down.sql
--
-- NOT tagged `intafaced:destructive`: it widens tickets_category_ck under the same name with `complaint` and
-- `bereavement`, and adds one table. It drops no table, no column and no row.
--
-- safety_cases: one acknowledgement per (person, kind, request key), beside the request it made. A complaint keeps the
-- final-response deadline fixed when it was acknowledged, from the owner's limit then; with the limit blank both deadline
-- columns stay null and the person reads "not set". Rows refuse update and delete: an acknowledgement is never rewritten.

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_category_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_category_ck"
  CHECK ("category" IN ('account', 'trading', 'deposit_withdraw', 'phishing', 'fraud_report', 'other', 'complaint', 'bereavement'));

CREATE TABLE IF NOT EXISTS "support"."safety_cases" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('complaint', 'bereavement')),
  "request_key" text NOT NULL CHECK (char_length("request_key") BETWEEN 8 AND 120),
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "reference" text NOT NULL UNIQUE CHECK ("reference" ~ '^[A-Z]{2}-[0-9A-F]{8}$'),
  "fingerprint" text NOT NULL CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  "response_limit_days" integer CHECK ("response_limit_days" IS NULL OR "response_limit_days" > 0),
  "response_due_at" timestamptz,
  "acknowledged_at" timestamptz NOT NULL,
  CONSTRAINT "safety_cases_once" UNIQUE ("user_id", "kind", "request_key"),
  CONSTRAINT "safety_cases_ticket_once" UNIQUE ("ticket_id"),
  CONSTRAINT "safety_cases_deadline_pair" CHECK (("response_limit_days" IS NULL) = ("response_due_at" IS NULL)),
  CONSTRAINT "safety_cases_deadline_complaint" CHECK ("kind" = 'complaint' OR "response_limit_days" IS NULL)
);
CREATE INDEX IF NOT EXISTS "safety_cases_user_idx" ON "support"."safety_cases" ("user_id", "acknowledged_at" DESC);

CREATE OR REPLACE FUNCTION "support"."safety_cases_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "safety_cases_append_only_trg" ON "support"."safety_cases";
CREATE TRIGGER "safety_cases_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."safety_cases"
  FOR EACH ROW EXECUTE FUNCTION "support"."safety_cases_append_only"();
