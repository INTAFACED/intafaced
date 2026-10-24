-- svc-academy · assistant drafts for a lesson (AC-course-structure-04)
-- Reversal: 0022_lesson_drafts.down.sql
--
-- A draft is keyed `draft:<item>:<revision>:<kind>`: one per lesson revision it
-- was drafted from and per kind. It is never what learners see: accepting it is
-- a person's action that writes a new lesson revision (source `assisted`) with
-- that person as the actor, and learners still see the published revision until
-- the next publish. Only the template path exists; a model path refuses
-- `owner.decision` while no provider is chosen.

CREATE TABLE IF NOT EXISTS "academy"."lesson_drafts" (
  "item_id"            uuid NOT NULL REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "based_on_revision"  integer NOT NULL,
  "kind"               text NOT NULL,
  "blocks"             jsonb NOT NULL,
  "state"              text NOT NULL DEFAULT 'open',
  "created_by"         uuid NOT NULL,
  "created_at"         timestamptz NOT NULL,
  "decided_by"         uuid,
  "decided_at"         timestamptz,
  "accepted_revision"  integer,
  PRIMARY KEY ("item_id", "based_on_revision", "kind"),
  CONSTRAINT "lesson_drafts_kind_chk" CHECK ("kind" IN ('template')),
  CONSTRAINT "lesson_drafts_state_chk" CHECK ("state" IN ('open', 'accepted', 'discarded')),
  CONSTRAINT "lesson_drafts_decided_chk" CHECK (("state" = 'open') = ("decided_by" IS NULL)
    AND ("state" = 'accepted') = ("accepted_revision" IS NOT NULL)),
  CONSTRAINT "lesson_drafts_blocks_chk" CHECK (jsonb_typeof("blocks") = 'array' AND jsonb_array_length("blocks") > 0)
);

ALTER TABLE "academy"."lesson_revisions" DROP CONSTRAINT IF EXISTS "lesson_revisions_source_chk";
ALTER TABLE "academy"."lesson_revisions"
  ADD CONSTRAINT "lesson_revisions_source_chk" CHECK ("source" IN ('saved', 'reverted', 'duplicated', 'imported', 'assisted'));
