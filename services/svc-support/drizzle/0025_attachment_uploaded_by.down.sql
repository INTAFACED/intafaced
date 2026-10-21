-- Reverse 0025_attachment_uploaded_by.sql
-- Lossy by nature: which operator added a file is dropped, and every file reads as added by its owner.

ALTER TABLE "support"."ticket_attachments" DROP COLUMN IF EXISTS "uploaded_by";
