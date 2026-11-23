-- svc-academy · a course's outline: sections of typed items (AC-course-structure-02)
-- Reversal: 0020_course_outline.down.sql
--
-- A save replaces the whole outline over the course revision the editor read,
-- and writes an `outline` event row. A `link` item carries an https address;
-- no other kind does. Item content is the lesson editor's (AC-course-structure-03).

CREATE TABLE IF NOT EXISTS "academy"."course_sections" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"  uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "position"   integer NOT NULL,
  "title"      text NOT NULL,
  CONSTRAINT "course_sections_position_uq" UNIQUE ("course_id", "position"),
  CONSTRAINT "course_sections_title_chk" CHECK (char_length(btrim("title")) > 0)
);

CREATE TABLE IF NOT EXISTS "academy"."course_items" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"   uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "section_id"  uuid NOT NULL REFERENCES "academy"."course_sections" ("id") ON DELETE CASCADE,
  "position"    integer NOT NULL,
  "kind"        text NOT NULL,
  "title"       text NOT NULL,
  "indent"      integer NOT NULL DEFAULT 0,
  "url"         text,
  CONSTRAINT "course_items_position_uq" UNIQUE ("section_id", "position"),
  CONSTRAINT "course_items_kind_chk" CHECK ("kind" IN ('lesson', 'video', 'file', 'quiz', 'assignment', 'discussion', 'link', 'subheader')),
  CONSTRAINT "course_items_indent_chk" CHECK ("indent" BETWEEN 0 AND 2),
  CONSTRAINT "course_items_url_chk" CHECK (("kind" = 'link') = ("url" IS NOT NULL) AND ("url" IS NULL OR "url" LIKE 'https://%')),
  CONSTRAINT "course_items_title_chk" CHECK (char_length(btrim("title")) > 0)
);
CREATE INDEX IF NOT EXISTS "course_items_course_idx" ON "academy"."course_items" ("course_id");

ALTER TABLE "academy"."course_events" DROP CONSTRAINT IF EXISTS "course_events_kind_chk";
ALTER TABLE "academy"."course_events"
  ADD CONSTRAINT "course_events_kind_chk" CHECK ("kind" IN ('created', 'updated', 'state', 'outline'));
