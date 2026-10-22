-- svc-support · ticket attachment scan state (SP-tickets-02)
-- Reversal: 0024_attachment_scan_state.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds one column and one index. A file is `scanning` from the moment its row is
-- written until the scanner answers, `clean` once it has, and `blocked` when it was refused. Every row written before
-- this migration was stored only after a clean verdict, so the default for existing rows is `clean`; new rows are
-- written `scanning` by the service. Only a `clean` file is ever served.

ALTER TABLE "support"."ticket_attachments" ADD COLUMN IF NOT EXISTS "scan_state" text NOT NULL DEFAULT 'clean';

ALTER TABLE "support"."ticket_attachments" DROP CONSTRAINT IF EXISTS "ticket_attachments_scan_state_ck";
ALTER TABLE "support"."ticket_attachments" ADD CONSTRAINT "ticket_attachments_scan_state_ck"
  CHECK ("scan_state" IN ('scanning', 'clean', 'blocked'));

CREATE INDEX IF NOT EXISTS "ticket_attachments_scanning_idx"
  ON "support"."ticket_attachments" ("created_at")
  WHERE "scan_state" = 'scanning';
