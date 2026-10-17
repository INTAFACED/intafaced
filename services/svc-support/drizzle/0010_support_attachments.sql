-- svc-support · attachment metadata (bytes stay in the upload store)
-- Reversal: 0010_support_attachments.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds one table. It drops no table,
-- no column, and no row. No file bytes, amount, balance, or currency column.
-- One row per owner idempotency key.

CREATE TABLE IF NOT EXISTS "support"."ticket_attachments" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_id"          uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "owner_id"           text NOT NULL,
  "client_request_id"  text NOT NULL,
  "store_key"          text NOT NULL,
  "content_type"       text NOT NULL,
  "byte_length"        integer NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("owner_id", "client_request_id")
);

ALTER TABLE "support"."ticket_attachments" DROP CONSTRAINT IF EXISTS "ticket_attachments_bytes_ck";
ALTER TABLE "support"."ticket_attachments" ADD CONSTRAINT "ticket_attachments_bytes_ck"
  CHECK ("byte_length" >= 0);

ALTER TABLE "support"."ticket_attachments" DROP CONSTRAINT IF EXISTS "ticket_attachments_request_len_ck";
ALTER TABLE "support"."ticket_attachments" ADD CONSTRAINT "ticket_attachments_request_len_ck"
  CHECK (char_length("client_request_id") BETWEEN 1 AND 200);

CREATE INDEX IF NOT EXISTS "ticket_attachments_ticket_idx"
  ON "support"."ticket_attachments" ("ticket_id");
