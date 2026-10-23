-- svc-support · help centre settings, publish switch and languages (SP-help-centre-03)
-- Reversal: 0030_help_centre.down.sql
--
-- One row holds the owner-set name, address, languages, setup mode and publish switch. Each is NULL until the owner
-- sets it: nothing is seeded, and a blank switch is not "on" or "off". Every change is appended to the log under a
-- business key (`support.helpCentre:r<revision>`) with who made it and why. The log refuses update and delete.
--
-- A translation row says whether one article version is translated or missing in one offered language. No row means
-- missing, computed on read, never inserted as a guess. The translation log is the receipt for a client request id.

CREATE TABLE IF NOT EXISTS "support"."help_centre" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
  "name" text CHECK ("name" IS NULL OR char_length("name") BETWEEN 1 AND 80),
  "address" text CHECK ("address" IS NULL OR (char_length("address") BETWEEN 12 AND 200 AND "address" LIKE 'https://%')),
  "default_language" text CHECK ("default_language" IS NULL OR "default_language" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$'),
  "languages" text[] CHECK ("languages" IS NULL OR cardinality("languages") BETWEEN 1 AND 24),
  "setup_mode" text CHECK ("setup_mode" IS NULL OR "setup_mode" IN ('setup', 'live')),
  "published" boolean,
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "updated_by" text,
  "updated_at" timestamptz
);

CREATE OR REPLACE FUNCTION "support"."help_centre_languages_ok"() RETURNS trigger AS $$
DECLARE
  tag text;
BEGIN
  IF NEW.default_language IS NOT NULL AND NEW.languages IS NOT NULL AND NOT (NEW.default_language = ANY (NEW.languages)) THEN
    RAISE EXCEPTION 'support.help_centre_setting_invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.languages IS NULL THEN
    RETURN NEW;
  END IF;
  IF cardinality(NEW.languages) < 1 OR cardinality(NEW.languages) > 24 THEN
    RAISE EXCEPTION 'support.help_centre_setting_invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(NEW.languages) AS x) <> cardinality(NEW.languages) THEN
    RAISE EXCEPTION 'support.help_centre_setting_invalid' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH tag IN ARRAY NEW.languages LOOP
    IF tag !~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$' THEN
      RAISE EXCEPTION 'support.help_centre_setting_invalid' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "help_centre_languages_ok_trg" ON "support"."help_centre";
CREATE TRIGGER "help_centre_languages_ok_trg"
  BEFORE INSERT OR UPDATE ON "support"."help_centre"
  FOR EACH ROW EXECUTE FUNCTION "support"."help_centre_languages_ok"();

CREATE TABLE IF NOT EXISTS "support"."help_centre_log" (
  "key" text PRIMARY KEY,
  "fingerprint" text NOT NULL,
  "revision_after" integer NOT NULL UNIQUE CHECK ("revision_after" >= 1),
  "before" jsonb NOT NULL,
  "after" jsonb NOT NULL,
  "set_by" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION "support"."help_centre_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.help_centre_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "help_centre_log_append_only_trg" ON "support"."help_centre_log";
CREATE TRIGGER "help_centre_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."help_centre_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."help_centre_log_append_only"();

CREATE TABLE IF NOT EXISTS "support"."help_centre_translation" (
  "article_id" text NOT NULL,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "language" text NOT NULL CHECK ("language" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$'),
  "state" text NOT NULL CHECK ("state" IN ('translated', 'missing')),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL,
  PRIMARY KEY ("article_id", "version", "language"),
  FOREIGN KEY ("article_id", "version") REFERENCES "support"."kb_article_versions" ("id", "version") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "support"."help_centre_translation_log" (
  "key" text PRIMARY KEY,
  "article_id" text NOT NULL,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "language" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('translated', 'missing')),
  "set_by" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION "support"."help_centre_translation_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.help_centre_translation_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "help_centre_translation_log_append_only_trg" ON "support"."help_centre_translation_log";
CREATE TRIGGER "help_centre_translation_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."help_centre_translation_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."help_centre_translation_log_append_only"();
