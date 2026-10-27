-- svc-identity · staff edits of a customer's personal details (J-ops-console-04 #9, OPS-accounts-desk-02). The details are
-- PII, so they are kept encrypted under the KYC document key (AES-256-GCM, as kyc_documents), never as plain columns.
-- Name, date of birth and tax number change only through a compliance review that a second founder passes; the record
-- keeps the old values until then. The history names the fields, the people and the reason, never a value.
-- Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."customer_details" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "version" bigint NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "ciphertext" bytea NOT NULL,
  "nonce" bytea NOT NULL,
  "key_id" text NOT NULL DEFAULT 'v1',
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS "identity"."customer_detail_reviews" (
  "review_id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "status" text NOT NULL CHECK ("status" IN ('open', 'passed', 'rejected')),
  "fields" text[] NOT NULL CHECK (cardinality("fields") BETWEEN 1 AND 3 AND "fields" <@ ARRAY['legalName', 'dateOfBirth', 'taxNumber']),
  -- The proposed values, encrypted; the review's document ids are KYC documents of this same customer.
  "ciphertext" bytea NOT NULL,
  "nonce" bytea NOT NULL,
  "key_id" text NOT NULL DEFAULT 'v1',
  "document_ids" uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality("document_ids") <= 5),
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 12 AND 255),
  "requested_by" uuid NOT NULL,
  "requested_at" timestamptz NOT NULL,
  "decided_by" uuid,
  "decided_at" timestamptz,
  "decision_note" text CHECK ("decision_note" IS NULL OR char_length("decision_note") BETWEEN 12 AND 255),
  CONSTRAINT "customer_detail_reviews_decision_ck" CHECK (
    ("status" = 'open') = ("decided_by" IS NULL)
    AND ("decided_by" IS NULL) = ("decided_at" IS NULL)
    AND ("decided_by" IS NULL) = ("decision_note" IS NULL)
    AND ("decided_by" IS NULL OR "decided_by" <> "requested_by")
  )
);
-- One open review per customer: a second edit of protected details waits for the first to be decided.
CREATE UNIQUE INDEX IF NOT EXISTS "customer_detail_reviews_one_open_idx"
  ON "identity"."customer_detail_reviews" ("user_id") WHERE "status" = 'open';
CREATE INDEX IF NOT EXISTS "customer_detail_reviews_user_idx"
  ON "identity"."customer_detail_reviews" ("user_id", "requested_at" DESC);

-- Every attempt, refused ones included, under its request id; a retry of the same request id reads the stored answer.
CREATE TABLE IF NOT EXISTS "identity"."customer_detail_events" (
  "audit_id" uuid PRIMARY KEY,
  "request_id" uuid NOT NULL,
  "actor_id" uuid,
  "user_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "result" jsonb NOT NULL,
  "stored" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "customer_detail_events_request_idx"
  ON "identity"."customer_detail_events" ("request_id") WHERE "stored";
CREATE INDEX IF NOT EXISTS "customer_detail_events_user_idx"
  ON "identity"."customer_detail_events" ("user_id", "created_at" DESC);
DROP TRIGGER IF EXISTS "customer_detail_events_immutable" ON "identity"."customer_detail_events";
CREATE TRIGGER "customer_detail_events_immutable" BEFORE UPDATE OR DELETE ON "identity"."customer_detail_events"
  FOR EACH ROW EXECUTE FUNCTION "identity"."founder_control_history_immutable"();
