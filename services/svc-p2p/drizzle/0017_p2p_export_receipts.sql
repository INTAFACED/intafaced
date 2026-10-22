-- P-trade-orders-14: audit row per capped export and per receipt download.
-- The receipt rows are also the quota counter, so a quota can never drift
-- from the audit trail. No balance is stored here.
-- Reversal: 0017_p2p_export_receipts.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."export_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "format" text,
  "trade_id" uuid,
  "range_from" timestamptz,
  "range_to" timestamptz,
  "row_count" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "export_audit_kind_ck" CHECK ("kind" IN ('export', 'receipt')),
  CONSTRAINT "export_audit_receipt_trade_ck" CHECK ("kind" <> 'receipt' OR "trade_id" IS NOT NULL),
  CONSTRAINT "export_audit_rows_ck" CHECK ("row_count" IS NULL OR "row_count" >= 0)
);

CREATE INDEX IF NOT EXISTS "export_audit_user_kind_idx" ON "p2p"."export_audit" ("user_id", "kind", "created_at");
