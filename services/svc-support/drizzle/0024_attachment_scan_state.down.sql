-- Reverse 0024_attachment_scan_state.sql
-- Lossy by nature: which files were held or blocked is dropped, and every remaining row reads as stored.

DROP INDEX IF EXISTS "support"."ticket_attachments_scanning_idx";
ALTER TABLE "support"."ticket_attachments" DROP CONSTRAINT IF EXISTS "ticket_attachments_scan_state_ck";
ALTER TABLE "support"."ticket_attachments" DROP COLUMN IF EXISTS "scan_state";
