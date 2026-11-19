-- svc-academy · course records (AC-course-structure-01)
-- Reversal: 0019_courses.down.sql
--
-- `courses`: a course staff create on the Academy desk. The slug is fixed at
-- creation; details change by revision. A paid course may be saved without a
-- price but never published without one. `price` is a catalogue figure, not a
-- balance: no money moves in this service (see README).
--
-- `course_events`: every create, edit and lifecycle move, with who and why.
-- Deleting a course is a state, never a row delete.

CREATE TABLE IF NOT EXISTS "academy"."courses" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"          text NOT NULL,
  "title"         text NOT NULL,
  "summary"       text,
  "thumbnail_url" text,
  "pricing"       text NOT NULL,
  "price"         numeric(38, 18),
  "price_asset"   text,
  "state"         text NOT NULL DEFAULT 'draft',
  "revision"      integer NOT NULL DEFAULT 1,
  "created_by"    uuid NOT NULL,
  "created_at"    timestamptz NOT NULL,
  "updated_at"    timestamptz NOT NULL,
  CONSTRAINT "courses_slug_uq" UNIQUE ("slug"),
  CONSTRAINT "courses_title_chk" CHECK (char_length(btrim("title")) > 0),
  CONSTRAINT "courses_pricing_chk" CHECK ("pricing" IN ('free', 'paid')),
  CONSTRAINT "courses_state_chk" CHECK ("state" IN ('draft', 'published', 'concluded', 'archived', 'deleted')),
  CONSTRAINT "courses_price_chk" CHECK (
    ("price" IS NULL) = ("price_asset" IS NULL)
    AND ("price" IS NULL OR ("pricing" = 'paid' AND "price" > 0))
  ),
  CONSTRAINT "courses_published_price_chk" CHECK ("state" = 'draft' OR "pricing" = 'free' OR "price" IS NOT NULL),
  CONSTRAINT "courses_revision_chk" CHECK ("revision" > 0)
);
CREATE INDEX IF NOT EXISTS "courses_state_idx" ON "academy"."courses" ("state", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "academy"."course_events" (
  "course_id"   uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "revision"    integer NOT NULL,
  "kind"        text NOT NULL,
  "from_state"  text,
  "to_state"    text NOT NULL,
  "actor"       uuid NOT NULL,
  "reason"      text,
  "at"          timestamptz NOT NULL,
  PRIMARY KEY ("course_id", "revision"),
  CONSTRAINT "course_events_kind_chk" CHECK ("kind" IN ('created', 'updated', 'state')),
  CONSTRAINT "course_events_reason_chk" CHECK ("kind" <> 'state' OR char_length(btrim(coalesce("reason", ''))) > 0)
);
