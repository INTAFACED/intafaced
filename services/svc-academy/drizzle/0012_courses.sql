-- svc-academy · course records, lifecycle events and the owner settings record (AC-course-structure-01)
-- Reversal: 0012_courses.down.sql
--
-- Deleting a course is a state, never a row delete. No money column holds a
-- balance: price is a one-time list price (numeric(38,18), decimal string on
-- the wire), null until set; a paid course without one refuses to publish.

CREATE TABLE IF NOT EXISTS "academy"."courses" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"          text NOT NULL,
  "title"         text NOT NULL,
  "category"      text,
  "thumbnail_url" text,
  "price_choice"  text NOT NULL,
  "price"         numeric(38, 18),
  "state"         text NOT NULL DEFAULT 'draft',
  "state_before_delete" text,
  "listed"        boolean NOT NULL DEFAULT false,
  "revision"      integer NOT NULL DEFAULT 0,
  "deleted_at"    timestamptz,
  "created_by"    uuid NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "courses_slug_uq" UNIQUE ("slug"),
  CONSTRAINT "courses_price_choice_chk" CHECK ("price_choice" IN ('free', 'paid')),
  CONSTRAINT "courses_free_no_price_chk" CHECK ("price_choice" = 'paid' OR "price" IS NULL),
  CONSTRAINT "courses_state_chk" CHECK ("state" IN ('draft', 'published', 'concluded', 'archived', 'deleted'))
);

CREATE TABLE IF NOT EXISTS "academy"."course_events" (
  "idempotency_key" text PRIMARY KEY,
  "course_id"       uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "from_state"      text,
  "to_state"        text NOT NULL,
  "revision"        integer NOT NULL,
  "actor"           uuid NOT NULL,
  "reason"          text NOT NULL,
  "at"              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "course_events_course_idx" ON "academy"."course_events" ("course_id", "at");

CREATE TABLE IF NOT EXISTS "academy"."course_settings" (
  "key"     text PRIMARY KEY,
  "value"   text NOT NULL,
  "set_by"  uuid NOT NULL,
  "set_at"  timestamptz NOT NULL DEFAULT now()
);

-- Append-only history of owner settings changes (actor and reason on every change).
CREATE TABLE IF NOT EXISTS "academy"."course_settings_events" (
  "id"      bigserial PRIMARY KEY,
  "key"     text NOT NULL,
  "value"   text NOT NULL,
  "actor"   uuid NOT NULL,
  "reason"  text NOT NULL,
  "at"      timestamptz NOT NULL DEFAULT now()
);
