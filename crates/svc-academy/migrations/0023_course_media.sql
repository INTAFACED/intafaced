-- svc-academy · videos, captions and handouts on course items (AC-videos-02)
-- Reversal: 0023_course_media.down.sql
--
-- An upload starts as an intent row keyed `media:<item>:<kind>:<sha256 of the file>`,
-- so the same file resumes the same row. The bytes go straight to our own object
-- store through a signed PUT; the row turns `ready` only after svc-academy reads
-- the stored object back and its size and leading bytes match what was declared.
-- A mismatch leaves the row `refused` with its reason. Captions are one SRT or
-- WebVTT file per video and language, stored as cues, so a re-cut video starts
-- with none of the old timings. Nothing here is executed.

CREATE TABLE IF NOT EXISTS "academy"."course_media" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"       uuid NOT NULL REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "kind"          text NOT NULL,
  "sha256"        text NOT NULL,
  "file_name"     text NOT NULL,
  "content_type"  text NOT NULL,
  "bytes"         bigint NOT NULL,
  "object_key"    text NOT NULL,
  "state"         text NOT NULL DEFAULT 'pending',
  "refusal"       text,
  "created_by"    uuid NOT NULL,
  "created_at"    timestamptz NOT NULL,
  "confirmed_at"  timestamptz,
  CONSTRAINT "course_media_key_uq" UNIQUE ("item_id", "kind", "sha256"),
  CONSTRAINT "course_media_kind_chk" CHECK ("kind" IN ('video', 'handout')),
  CONSTRAINT "course_media_state_chk" CHECK ("state" IN ('pending', 'ready', 'refused')),
  CONSTRAINT "course_media_sha_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "course_media_bytes_chk" CHECK ("bytes" > 0)
);
CREATE INDEX IF NOT EXISTS "course_media_item_idx" ON "academy"."course_media" ("item_id");

CREATE TABLE IF NOT EXISTS "academy"."course_item_captions" (
  "item_id"   uuid NOT NULL REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "media_id"  uuid NOT NULL REFERENCES "academy"."course_media" ("id") ON DELETE CASCADE,
  "language"  text NOT NULL,
  "label"     text NOT NULL,
  "format"    text NOT NULL,
  "source"    text NOT NULL,
  "cues"      jsonb NOT NULL,
  "set_by"    uuid NOT NULL,
  "set_at"    timestamptz NOT NULL,
  PRIMARY KEY ("media_id", "language"),
  CONSTRAINT "course_item_captions_format_chk" CHECK ("format" IN ('srt', 'vtt'))
);
