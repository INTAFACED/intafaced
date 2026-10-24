-- MC-token-01. One governance space, follow rows, and the proposer rule.
-- No stake minimum, period, or proposal cap is written here. Blank stays blank.

CREATE TABLE IF NOT EXISTS "token"."governance_spaces" (
  "id" text PRIMARY KEY,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "token"."governance_spaces" ("id")
VALUES ('ifc')
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "token"."governance_follows" (
  "space_id" text NOT NULL REFERENCES "token"."governance_spaces" ("id"),
  "account_id" text NOT NULL,
  "following" boolean NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("space_id", "account_id")
);

CREATE TABLE IF NOT EXISTS "token"."governance_proposer" (
  "id" boolean PRIMARY KEY DEFAULT true,
  "kind" text,
  "min_stake" numeric(38, 18),
  "accounts" jsonb,
  "period_limit" integer,
  "period_ms" bigint,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "governance_proposer_singleton" CHECK ("id"),
  CONSTRAINT "governance_proposer_kind_ck" CHECK (
    "kind" IS NULL OR "kind" IN ('stake', 'authors', 'listed')
  ),
  CONSTRAINT "governance_proposer_min_stake_ck" CHECK ("min_stake" IS NULL OR "min_stake" >= 0),
  CONSTRAINT "governance_proposer_period_ck" CHECK (
    ("period_limit" IS NULL OR "period_limit" >= 0)
    AND ("period_ms" IS NULL OR "period_ms" >= 0)
  )
);

INSERT INTO "token"."governance_proposer" ("id")
VALUES (true)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "token"."proposals"
  ADD COLUMN IF NOT EXISTS "author_id" text,
  ADD COLUMN IF NOT EXISTS "title" text,
  ADD COLUMN IF NOT EXISTS "body_md" text,
  ADD COLUMN IF NOT EXISTS "discussion_link" text,
  ADD COLUMN IF NOT EXISTS "business_key" text,
  ADD COLUMN IF NOT EXISTS "request_handle" text,
  ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "ordinal" integer,
  ADD COLUMN IF NOT EXISTS "space_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "proposals_business_key_idx"
  ON "token"."proposals" ("business_key")
  WHERE "business_key" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "proposals_request_handle_idx"
  ON "token"."proposals" ("space_id", "author_id", "request_handle")
  WHERE "request_handle" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "proposals_ordinal_idx"
  ON "token"."proposals" ("space_id", "author_id", "ordinal")
  WHERE "ordinal" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "proposals_author_created_idx"
  ON "token"."proposals" ("author_id", "created_at");
