-- svc-academy · learning programmes (AC-programmes-01)
-- Reversal: 20261024164302_learning_programmes.down.sql
--
-- A learning programme is an ordered set of published courses that staff make. It recommends an order and enforces none.
-- Each save is a revision with an event row naming the operator and the reason. Finishing every course in a programme
-- issues its certificate once, as a cert_grants row under the id `programme:<slug>`. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."programmes" (
  "slug"       text PRIMARY KEY,
  "title"      text NOT NULL,
  "summary"    text NOT NULL,
  "revision"   integer NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "programmes_slug_chk" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 3 AND 48),
  CONSTRAINT "programmes_title_chk" CHECK (length(btrim("title")) BETWEEN 1 AND 120),
  CONSTRAINT "programmes_revision_chk" CHECK ("revision" >= 1)
);

CREATE TABLE IF NOT EXISTS "academy"."programme_courses" (
  "programme_slug" text NOT NULL REFERENCES "academy"."programmes" ("slug") ON DELETE CASCADE,
  "position"       integer NOT NULL,
  "course_slug"    text NOT NULL,
  PRIMARY KEY ("programme_slug", "position"),
  CONSTRAINT "programme_courses_course_uq" UNIQUE ("programme_slug", "course_slug"),
  CONSTRAINT "programme_courses_course_chk" CHECK ("course_slug" IN ('foundations', 'markets', 'builder', 'sovereign'))
);
CREATE INDEX IF NOT EXISTS "programme_courses_course_idx" ON "academy"."programme_courses" ("course_slug");

CREATE TABLE IF NOT EXISTS "academy"."programme_events" (
  "id"             bigserial PRIMARY KEY,
  "programme_slug" text NOT NULL REFERENCES "academy"."programmes" ("slug") ON DELETE CASCADE,
  "revision"       integer NOT NULL,
  "course_slugs"   text[] NOT NULL,
  "operator_id"    uuid NOT NULL,
  "reason"         text NOT NULL,
  "recorded_at"    timestamptz NOT NULL,
  CONSTRAINT "programme_events_revision_uq" UNIQUE ("programme_slug", "revision"),
  CONSTRAINT "programme_events_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);
