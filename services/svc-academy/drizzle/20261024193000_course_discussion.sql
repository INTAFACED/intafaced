-- svc-academy · course discussion (AC-rooms-01)
-- Reversal: 20261024193000_course_discussion.down.sql
--
-- The discussion of a course staff made. Every course has a default General topic, which is not a row; staff add
-- course-wide topics with a pin and a position. A post is a question or a discussion in one topic; a reply belongs to one
-- post (replies nest one level). The author may post anonymously to classmates: the account is still stored, and staff
-- see it. A post may carry one image, kept here under the owner's size limit. Follow and like are one row per account.
-- A retry with the same client request id is the same post or reply. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."discussion_topics" (
  "course_id"  uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "slug"       text NOT NULL,
  "title"      text NOT NULL,
  "pinned"     boolean NOT NULL,
  "position"   integer NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("course_id", "slug"),
  CONSTRAINT "discussion_topics_slug_chk" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 3 AND 48 AND "slug" <> 'general'),
  CONSTRAINT "discussion_topics_title_chk" CHECK (length(btrim("title")) BETWEEN 1 AND 120),
  CONSTRAINT "discussion_topics_position_chk" CHECK ("position" >= 0)
);

CREATE TABLE IF NOT EXISTS "academy"."discussion_topic_events" (
  "id"          bigserial PRIMARY KEY,
  "course_id"   uuid NOT NULL,
  "slug"        text NOT NULL,
  "title"       text NOT NULL,
  "pinned"      boolean NOT NULL,
  "position"    integer NOT NULL,
  "operator_id" uuid NOT NULL,
  "reason"      text NOT NULL,
  "recorded_at" timestamptz NOT NULL,
  FOREIGN KEY ("course_id", "slug") REFERENCES "academy"."discussion_topics" ("course_id", "slug"),
  CONSTRAINT "discussion_topic_events_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS "academy"."discussion_posts" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"          uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "topic_slug"         text NOT NULL,
  -- null for a post; the post's id for a reply
  "parent_id"          uuid REFERENCES "academy"."discussion_posts" ("id"),
  "kind"               text,
  "title"              text,
  "body"               text NOT NULL,
  "author_id"          uuid NOT NULL,
  "anonymous"          boolean NOT NULL,
  "image_type"         text,
  "image"              bytea,
  "accepted_reply_id"  uuid REFERENCES "academy"."discussion_posts" ("id"),
  "client_request_id"  text NOT NULL,
  "created_at"         timestamptz NOT NULL,
  CONSTRAINT "discussion_posts_request_uq" UNIQUE ("author_id", "client_request_id"),
  CONSTRAINT "discussion_posts_shape_chk" CHECK (
    ("parent_id" IS NULL AND "kind" IN ('question', 'discussion') AND length(btrim("title")) BETWEEN 1 AND 200)
    OR ("parent_id" IS NOT NULL AND "kind" IS NULL AND "title" IS NULL AND "image" IS NULL AND "accepted_reply_id" IS NULL)
  ),
  CONSTRAINT "discussion_posts_image_chk" CHECK (
    ("image" IS NULL AND "image_type" IS NULL) OR ("image" IS NOT NULL AND "image_type" IN ('image/png', 'image/jpeg', 'image/gif'))
  ),
  CONSTRAINT "discussion_posts_accepted_chk" CHECK ("accepted_reply_id" IS NULL OR "kind" = 'question')
);
CREATE INDEX IF NOT EXISTS "discussion_posts_topic_idx"
  ON "academy"."discussion_posts" ("course_id", "topic_slug", "created_at" DESC) WHERE "parent_id" IS NULL;
CREATE INDEX IF NOT EXISTS "discussion_posts_parent_idx" ON "academy"."discussion_posts" ("parent_id", "created_at");

CREATE TABLE IF NOT EXISTS "academy"."discussion_follows" (
  "post_id"    uuid NOT NULL REFERENCES "academy"."discussion_posts" ("id"),
  "user_id"    uuid NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("post_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "academy"."discussion_likes" (
  "post_id"    uuid NOT NULL REFERENCES "academy"."discussion_posts" ("id"),
  "user_id"    uuid NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("post_id", "user_id")
);
