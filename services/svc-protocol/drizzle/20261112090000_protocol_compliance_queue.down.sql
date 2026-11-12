-- intafaced:destructive — reversal of 20261112090000_protocol_compliance_queue.sql
DROP TABLE IF EXISTS "protocol"."address_label_reviews";
ALTER TABLE "protocol"."address_reports" DROP COLUMN IF EXISTS "duplicates_refused";
