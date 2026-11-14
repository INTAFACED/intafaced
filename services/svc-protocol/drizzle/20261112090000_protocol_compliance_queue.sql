-- svc-protocol · the compliance queue (D-developer-compliance-01, J-dex-protocol-30 #1 #2)
-- Reversal: 20261112090000_protocol_compliance_queue.down.sql
--
-- A refused duplicate report is counted on the open report it duplicates, so the queue can say the duplicate was
-- refused. A label is published by two different people: the first asks (a pending review), the second approves, and the
-- label, its history row and the report's status change in one transaction. No balance, no money and no key.

ALTER TABLE "protocol"."address_reports" ADD COLUMN IF NOT EXISTS "duplicates_refused" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "protocol"."address_label_reviews" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "report_id"    uuid NOT NULL REFERENCES "protocol"."address_reports" ("id"),
  "kind"         text NOT NULL,
  "reason"       text NOT NULL,
  "status"       text NOT NULL DEFAULT 'pending',
  "requester_id" text NOT NULL,
  "approver_id"  text,
  "asked_at"     timestamptz NOT NULL DEFAULT now(),
  "decided_at"   timestamptz,
  CONSTRAINT "address_label_reviews_kind_ck" CHECK ("kind" IN ('name', 'exchange', 'risk', 'sanctioned', 'phishing', 'contract_type')),
  CONSTRAINT "address_label_reviews_status_ck" CHECK ("status" IN ('pending', 'published')),
  CONSTRAINT "address_label_reviews_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  -- Four eyes: the approver is never the person who asked.
  CONSTRAINT "address_label_reviews_four_eyes_ck" CHECK ("approver_id" IS NULL OR "approver_id" <> "requester_id"),
  CONSTRAINT "address_label_reviews_decided_ck" CHECK (("status" = 'pending') = ("approver_id" IS NULL AND "decided_at" IS NULL))
);
-- The business key: one pending review per report and label kind.
CREATE UNIQUE INDEX IF NOT EXISTS "address_label_reviews_pending_idx" ON "protocol"."address_label_reviews" ("report_id", "kind") WHERE "status" = 'pending';
