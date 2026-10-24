-- svc-support · help centre settings, publish switch and languages (SP-help-centre-03)
-- Reversal: 0031_help_centre.down.sql
--
-- Number 0031: origin/main's highest svc-support migration is 0029, and 0030 is the desk-views migration
-- landing on another branch. This file is the registry entry; scripts/migrate.ts applies NNNN_*.sql in name order.
--
-- One row holds the owner-set name, address, languages, setup mode and publish switch. Each is NULL until the owner
-- sets it: nothing is seeded, and a blank switch is not "on" or "off". Every change is appended to the log under a
-- business key (`support.helpCentre:r<revision>`) with who made it and why. The log refuses update and delete.
--
-- A translation row says whether one article version is translated or missing in one offered language. No row means
-- missing, computed on read, never inserted as a guess. The translation log is the receipt for a client request id.
--
-- help_centre_address_ok is the column check for supportHelpCentreAddressProblem: after trim, length 1..200, an https
-- URL with a host and no user or password. Case is not significant and there is no floor of 12. The service stores
-- the https href; a value the check still refuses is support.help_centre_setting_invalid, not an untyped error.

CREATE OR REPLACE FUNCTION "support"."help_centre_address_ok"(raw text) RETURNS boolean AS $$
DECLARE
  trimmed text;
  rest text;
  auth text;
  at_pos int;
  userinfo text;
  hostport text;
  host text;
  port text;
  after text;
  endb int;
  colon int;
  stripped text;
BEGIN
  IF raw IS NULL THEN
    RETURN true;
  END IF;
  trimmed := btrim(raw);
  IF char_length(trimmed) < 1 OR char_length(trimmed) > 200 THEN
    RETURN false;
  END IF;
  IF trimmed !~* '^https:' THEN
    RETURN false;
  END IF;
  rest := replace(substring(trimmed from 7), chr(92), '/');
  rest := regexp_replace(rest, '^/+', '');
  auth := substring(rest from '^[^/?#]*');
  IF auth = '' OR auth ~ '[[:space:][:cntrl:]]' THEN
    RETURN false;
  END IF;
  IF position('@' in auth) > 0 THEN
    at_pos := char_length(auth) - position('@' in reverse(auth)) + 1;
    userinfo := substring(auth from 1 for at_pos - 1);
    hostport := substring(auth from at_pos + 1);
    IF userinfo <> '' AND userinfo <> ':' THEN
      RETURN false;
    END IF;
  ELSE
    hostport := auth;
  END IF;
  IF hostport = '' THEN
    RETURN false;
  END IF;
  IF left(hostport, 1) = '[' THEN
    endb := position(']' in hostport);
    IF endb < 3 THEN
      RETURN false;
    END IF;
    host := substring(hostport from 2 for endb - 2);
    after := substring(hostport from endb + 1);
    IF after <> '' AND after !~ '^:[0-9]*$' THEN
      RETURN false;
    END IF;
    port := CASE WHEN left(after, 1) = ':' THEN substring(after from 2) ELSE '' END;
    IF host !~ '^[0-9A-Fa-f:.]+$' THEN
      RETURN false;
    END IF;
    IF position('::' in host) = 0 AND (char_length(host) - char_length(replace(host, ':', ''))) < 2 THEN
      RETURN false;
    END IF;
  ELSIF position(':' in hostport) > 0 THEN
    colon := char_length(hostport) - position(':' in reverse(hostport)) + 1;
    port := substring(hostport from colon + 1);
    host := substring(hostport from 1 for colon - 1);
    IF port !~ '^[0-9]*$' OR position(':' in host) > 0 THEN
      RETURN false;
    END IF;
  ELSE
    host := hostport;
    port := '';
  END IF;
  IF host = '' THEN
    RETURN false;
  END IF;
  IF port <> '' THEN
    IF port !~ '^[0-9]+$' THEN
      RETURN false;
    END IF;
    stripped := regexp_replace(port, '^0+', '');
    IF stripped = '' THEN
      stripped := '0';
    END IF;
    IF char_length(stripped) > 5 OR stripped::integer > 65535 THEN
      RETURN false;
    END IF;
  END IF;
  IF left(hostport, 1) <> '[' THEN
    IF host ~ '[[:space:][:cntrl:]]' OR position(chr(92) in host) > 0 OR translate(host, '#/?@[]^|<>', '') <> host THEN
      RETURN false;
    END IF;
    IF position('%' in regexp_replace(host, '%[0-9A-Fa-f]{2}', '', 'g')) > 0 THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS "support"."help_centre" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
  "name" text CHECK ("name" IS NULL OR char_length("name") BETWEEN 1 AND 80),
  "address" text,
  CONSTRAINT "help_centre_address_ck" CHECK ("address" IS NULL OR "support"."help_centre_address_ok"("address")),
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
