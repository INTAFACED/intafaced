-- svc-academy · private links to a course's unlisted page (AC-catalogue-03)
-- Reversal: 0025_course_private_links.down.sql
--
-- Staff make a link to a course's page before it is listed. The key is shown
-- once; only its SHA-256 is stored, so a stolen table opens nothing. A revoked
-- link stays as a row with who revoked it and why, and opens nothing.

CREATE TABLE IF NOT EXISTS "academy"."course_private_links" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"      uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "key_sha256"     text NOT NULL UNIQUE,
  "reason"         text NOT NULL,
  "created_by"     uuid NOT NULL,
  "created_at"     timestamptz NOT NULL,
  "revoked_by"     uuid,
  "revoked_at"     timestamptz,
  "revoke_reason"  text,
  CONSTRAINT "course_private_links_key_chk" CHECK ("key_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "course_private_links_reason_chk" CHECK (char_length(btrim("reason")) > 0),
  CONSTRAINT "course_private_links_revoked_chk"
    CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL) AND ("revoked_at" IS NULL) = ("revoke_reason" IS NULL))
);
CREATE INDEX IF NOT EXISTS "course_private_links_course_idx" ON "academy"."course_private_links" ("course_id", "created_at" DESC);
