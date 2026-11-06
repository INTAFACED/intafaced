-- PF-statements-02 (J-portfolio-11 #4, #5): background exports. One row per export a person asked for, keyed by what was
-- asked (`key`, the business key), so the same request returns the same job. The worker claims a queued row, or one
-- whose claim lapsed because the worker died, renders the file as of `as_of` and writes it once. The file is a copy of the
-- person's own posted lines; it states no balance and this table holds no amount.
CREATE TABLE IF NOT EXISTS "bank"."statement_jobs" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "key" text NOT NULL,
  "report" text NOT NULL,
  "format" text NOT NULL,
  "from_at" text NOT NULL,
  "to_at" text NOT NULL,
  "asset_id" text,
  "space_id" text,
  "state" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  -- Until when the worker that claimed it owns it; a claim past this is re-queued on the same key.
  "lease_until" timestamptz,
  -- The moment the file is rendered as of, fixed at request, so a second render writes the same bytes.
  "as_of" timestamptz NOT NULL,
  "filename" text,
  "content_type" text,
  "body" bytea,
  "sha256" text,
  "signature" text,
  "row_count" integer,
  "error_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "statement_jobs_key_uq" UNIQUE ("user_id", "key"),
  CONSTRAINT "statement_jobs_report_ck" CHECK ("report" IN ('statement', 'ledger', 'trades')),
  CONSTRAINT "statement_jobs_format_ck" CHECK ("format" IN ('csv', 'pdf')),
  CONSTRAINT "statement_jobs_state_ck" CHECK ("state" IN ('queued', 'rendering', 'ready', 'failed')),
  CONSTRAINT "statement_jobs_steps_ck" CHECK (
    ("state" = 'queued' AND "body" IS NULL AND "error_code" IS NULL)
    OR ("state" = 'rendering' AND "body" IS NULL AND "error_code" IS NULL AND "lease_until" IS NOT NULL)
    OR ("state" = 'ready' AND "body" IS NOT NULL AND "sha256" IS NOT NULL AND "signature" IS NOT NULL
        AND "filename" IS NOT NULL AND "content_type" IS NOT NULL AND "row_count" IS NOT NULL AND "finished_at" IS NOT NULL)
    OR ("state" = 'failed' AND "body" IS NULL AND "error_code" IS NOT NULL AND "finished_at" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "statement_jobs_user_idx" ON "bank"."statement_jobs" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "statement_jobs_open_idx"
  ON "bank"."statement_jobs" ("created_at")
  WHERE "state" IN ('queued', 'rendering');
