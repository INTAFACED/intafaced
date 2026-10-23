-- svc-academy · item prerequisites, availability windows, per-learner extensions
-- Reversal: 0012_item_release.down.sql
--
-- Items are curriculum slugs the lesson screen already opens. A row is an
-- owner rule. No row means no extra gate. Programme enrolment checks stay
-- on the programme catalog and are not stored here.

CREATE TABLE IF NOT EXISTS "academy"."item_prerequisites" (
  "item_slug"           text NOT NULL,
  "prerequisite_slug"   text NOT NULL,
  PRIMARY KEY ("item_slug", "prerequisite_slug"),
  CONSTRAINT "item_prerequisites_not_self_chk" CHECK ("item_slug" <> "prerequisite_slug")
);

CREATE TABLE IF NOT EXISTS "academy"."item_windows" (
  "item_slug"         text PRIMARY KEY,
  "available_from"    timestamptz NOT NULL,
  "available_until"   timestamptz NOT NULL,
  "due_at"            timestamptz,
  CONSTRAINT "item_windows_order_chk" CHECK ("available_until" > "available_from"),
  CONSTRAINT "item_windows_due_chk" CHECK (
    "due_at" IS NULL
    OR ("due_at" >= "available_from" AND "due_at" <= "available_until")
  )
);

CREATE TABLE IF NOT EXISTS "academy"."item_extensions" (
  "user_id"             uuid NOT NULL,
  "item_slug"           text NOT NULL,
  "revision"            integer NOT NULL,
  "reason"              text NOT NULL,
  "extended_until"      timestamptz NOT NULL,
  "client_request_id"   text NOT NULL,
  "granted_by"          uuid NOT NULL,
  "granted_at"          timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "item_slug", "revision"),
  CONSTRAINT "item_extensions_reason_chk" CHECK (char_length(btrim("reason")) > 0),
  CONSTRAINT "item_extensions_revision_chk" CHECK ("revision" > 0)
);

-- Replay identity is the learner, the item, and the client request.
-- request_once still forbids storing a second item under the same request id.
-- The write refuses that reuse so the caller does not receive the first grant.
CREATE UNIQUE INDEX IF NOT EXISTS "item_extensions_request_uq"
  ON "academy"."item_extensions" ("user_id", "item_slug", "client_request_id");

CREATE UNIQUE INDEX IF NOT EXISTS "item_extensions_request_once_uq"
  ON "academy"."item_extensions" ("user_id", "client_request_id");
