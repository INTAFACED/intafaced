-- svc-academy · videos on curriculum items and their caption tracks (AC-videos-01)
-- Reversal: 0018_item_videos.down.sql
--
-- `item_videos`: the video staff attach to one curriculum item, with a reason.
-- An item with a video completes by the `watch` rule: the learner's stored
-- watch position reaching the owner's threshold completes it.
--
-- `video_tracks`: one caption track per video and language, as staff
-- uploaded it (WebVTT text). The transcript is the same cues.

CREATE TABLE IF NOT EXISTS "academy"."item_videos" (
  "item_slug"   text PRIMARY KEY,
  "video_slug"  text NOT NULL,
  "reason"      text NOT NULL,
  "set_by"      uuid NOT NULL,
  "set_at"      timestamptz NOT NULL,
  CONSTRAINT "item_videos_reason_chk" CHECK (char_length(btrim("reason")) > 0)
);
CREATE INDEX IF NOT EXISTS "item_videos_video_idx" ON "academy"."item_videos" ("video_slug");

CREATE TABLE IF NOT EXISTS "academy"."video_tracks" (
  "video_slug"  text NOT NULL,
  "language"    text NOT NULL,
  "label"       text NOT NULL,
  "vtt"         text NOT NULL,
  "position"    integer NOT NULL,
  "reason"      text NOT NULL,
  "set_by"      uuid NOT NULL,
  "set_at"      timestamptz NOT NULL,
  PRIMARY KEY ("video_slug", "language"),
  CONSTRAINT "video_tracks_reason_chk" CHECK (char_length(btrim("reason")) > 0)
);
