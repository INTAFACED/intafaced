-- svc-support · who added a ticket file (SP-tickets-02 agent upload)
-- Reversal: 0025_attachment_uploaded_by.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds one nullable column. A file keeps the ticket owner as `owner_id`, so the
-- customer sees it like a comment; `uploaded_by` names the operator who added it, or is NULL when the owner did. Every
-- row written before this migration was added by its owner, so NULL is right for them.

ALTER TABLE "support"."ticket_attachments" ADD COLUMN IF NOT EXISTS "uploaded_by" text;
