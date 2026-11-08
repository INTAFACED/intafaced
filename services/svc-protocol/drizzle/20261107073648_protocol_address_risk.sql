-- svc-protocol · address risk: the label store and the scam report queue (D-developer-compliance-01)
-- Reversal: 20261107073648_protocol_address_risk.down.sql
--
-- A label is a published record about an address (a name, a risk, a phishing mark), never a verdict. Labels are published
-- only through the compliance queue (the next part of D-developer-compliance-01), which writes the label and its history
-- row in one transaction, so an old value stays readable; this migration only creates the store, and nothing writes it yet.
-- Addresses are compared in lower case, so a row in any letter case is found. A report is one signed-in person's claim
-- about an address; its reporter and note are compliance-only and are never served to the public, which reads a count.
-- No balance, no money and no key.

CREATE TABLE IF NOT EXISTS "protocol"."address_labels" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chain_id"     integer NOT NULL,
  -- Checksummed EVM address the label is about.
  "address"      text NOT NULL,
  "kind"         text NOT NULL,
  "value"        text NOT NULL,
  "source"       text NOT NULL,
  "reputation"   text NOT NULL,
  -- Why the label was published, in words, and where its evidence can be read.
  "reason"       text NOT NULL,
  "evidence_url" text,
  "set_by"       text NOT NULL,
  "version"      integer NOT NULL DEFAULT 1,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "address_labels_address_shape_ck" CHECK ("address" ~ '^0x[0-9a-fA-F]{40}$'),
  CONSTRAINT "address_labels_kind_ck" CHECK ("kind" IN ('name', 'exchange', 'risk', 'sanctioned', 'phishing', 'contract_type')),
  CONSTRAINT "address_labels_source_ck" CHECK ("source" IN ('curator', 'user_report', 'vendor', 'owner_proof')),
  CONSTRAINT "address_labels_reputation_ck" CHECK ("reputation" IN ('UNKNOWN', 'OK', 'CAUTION', 'UNSAFE')),
  CONSTRAINT "address_labels_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  -- An evidence link is only ever an http(s) link, so it can be shown as a link.
  CONSTRAINT "address_labels_evidence_ck" CHECK ("evidence_url" IS NULL OR "evidence_url" ~ '^https?://')
);
-- One label of each kind per address and chain; a change is a new version with a history row.
CREATE UNIQUE INDEX IF NOT EXISTS "address_labels_chain_address_kind_idx" ON "protocol"."address_labels" ("chain_id", lower("address"), "kind");

CREATE TABLE IF NOT EXISTS "protocol"."address_label_history" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label_id"     uuid NOT NULL REFERENCES "protocol"."address_labels" ("id"),
  "version"      integer NOT NULL,
  "value"        text NOT NULL,
  "reputation"   text NOT NULL,
  "reason"       text NOT NULL,
  "evidence_url" text,
  "set_by"       text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "address_label_history_version_uq" UNIQUE ("label_id", "version"),
  CONSTRAINT "address_label_history_evidence_ck" CHECK ("evidence_url" IS NULL OR "evidence_url" ~ '^https?://')
);

CREATE TABLE IF NOT EXISTS "protocol"."address_reports" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The business key: report:<reporterId>:<chainId>:<address>. One open report per reporter and address.
  "idempotency_key" text NOT NULL,
  "chain_id"        integer NOT NULL,
  "address"         text NOT NULL,
  -- The signed-in person who reported. Compliance only; never served to the public.
  "reporter_id"     text NOT NULL,
  "kind"            text NOT NULL,
  "evidence_url"    text,
  "note"            text,
  "status"          text NOT NULL DEFAULT 'open',
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "address_reports_address_shape_ck" CHECK ("address" ~ '^0x[0-9a-fA-F]{40}$'),
  CONSTRAINT "address_reports_kind_ck" CHECK ("kind" IN ('scam', 'phishing', 'impersonation', 'other')),
  CONSTRAINT "address_reports_status_ck" CHECK ("status" IN ('open', 'published', 'dismissed')),
  CONSTRAINT "address_reports_note_ck" CHECK ("note" IS NULL OR char_length("note") <= 1000),
  CONSTRAINT "address_reports_evidence_ck" CHECK ("evidence_url" IS NULL OR "evidence_url" ~ '^https?://')
);
CREATE UNIQUE INDEX IF NOT EXISTS "address_reports_open_key_idx" ON "protocol"."address_reports" ("idempotency_key") WHERE "status" = 'open';
CREATE INDEX IF NOT EXISTS "address_reports_chain_address_idx" ON "protocol"."address_reports" ("chain_id", lower("address"));
