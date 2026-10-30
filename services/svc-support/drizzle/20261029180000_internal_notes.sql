-- svc-support · internal notes (SP-tickets-05)
-- Reversal: 20261029180000_internal_notes.down.sql
--
-- A comment is public (on the customer's thread) or internal (a staff-only note). Every row written before this is
-- public. Only an operator writes a note; the check refuses anything else even if the service had a bug.

ALTER TABLE "support"."comments" ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'public';
ALTER TABLE "support"."comments" DROP CONSTRAINT IF EXISTS "comments_visibility_ck";
ALTER TABLE "support"."comments" ADD CONSTRAINT "comments_visibility_ck"
  CHECK ("visibility" = 'public' OR ("visibility" = 'internal' AND "author_role" = 'operator'));
