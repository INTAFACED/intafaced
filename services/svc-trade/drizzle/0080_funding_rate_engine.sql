-- trade.funding_params, trade.funding_index_sources, trade.funding_rate_samples, trade.funding_rate_periods
-- Reversal: 0080_funding_rate_engine.down.sql
--
-- D-instruments-01: the funding rate engine. Every owner number is a nullable column and NULL means blank: the
-- computer refuses a period with trade.funding_rate_unset and never reads a blank as zero funding. No money moves
-- through these tables. A published rate reaches the funding tick through the in-process rate source, and the
-- tick keeps freezing the first rate it sees in funding_period_rates.
--
-- trade.operator_append_only() comes from 0055.

-- One row per version of a market's funding parameters. The current row is the highest version.
CREATE TABLE IF NOT EXISTS "trade"."funding_params" (
  "id"               uuid        PRIMARY KEY,
  "market_id"        text        NOT NULL,
  "version"          bigint      NOT NULL CHECK ("version" >= 1),
  "base_component"   text,
  "cap"              text,
  "cadence_seconds"  integer     CHECK ("cadence_seconds" IS NULL OR "cadence_seconds" >= 1),
  "trim_ratio_bps"   integer     CHECK ("trim_ratio_bps" IS NULL OR ("trim_ratio_bps" >= 0 AND "trim_ratio_bps" < 5000)),
  "min_samples"      integer     CHECK ("min_samples" IS NULL OR "min_samples" >= 1),
  "period_seconds"   integer     CHECK ("period_seconds" IS NULL OR "period_seconds" >= 1),
  "period_anchor"    timestamptz,
  "operator_id"      text        NOT NULL,
  "approver_id"      text        NOT NULL,
  "reason"           text        NOT NULL,
  "approval_id"      text        NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("market_id", "version")
);

DROP TRIGGER IF EXISTS funding_params_append_only ON "trade"."funding_params";
CREATE TRIGGER funding_params_append_only
  BEFORE UPDATE OR DELETE ON "trade"."funding_params"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- One row per version of a market's index sources and the owner floor and bands the index is built under.
CREATE TABLE IF NOT EXISTS "trade"."funding_index_sources" (
  "id"                 uuid        PRIMARY KEY,
  "market_id"          text        NOT NULL,
  "version"            bigint      NOT NULL CHECK ("version" >= 1),
  "sources"            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "min_sources"        integer     CHECK ("min_sources" IS NULL OR "min_sources" >= 1),
  "outlier_band_bps"   integer     CHECK ("outlier_band_bps" IS NULL OR "outlier_band_bps" >= 1),
  "max_age_seconds"    integer     CHECK ("max_age_seconds" IS NULL OR "max_age_seconds" >= 1),
  "operator_id"        text        NOT NULL,
  "approver_id"        text        NOT NULL,
  "reason"             text        NOT NULL,
  "approval_id"        text        NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("market_id", "version")
);

DROP TRIGGER IF EXISTS funding_index_sources_append_only ON "trade"."funding_index_sources";
CREATE TRIGGER funding_index_sources_append_only
  BEFORE UPDATE OR DELETE ON "trade"."funding_index_sources"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- One premium sample slot. sampled_at is the slot boundary, so a retry of the same slot is a no-op. A gap is a row
-- with a NULL mark or index and the reason; it is never stored as zero and never averaged.
CREATE TABLE IF NOT EXISTS "trade"."funding_rate_samples" (
  "market_id"    text            NOT NULL,
  "sampled_at"   timestamptz     NOT NULL,
  "mark"         numeric(38, 18),
  "index_price"  numeric(38, 18),
  "gap_reason"   text,
  "created_at"   timestamptz     NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("market_id", "sampled_at"),
  CONSTRAINT "funding_rate_samples_positive_ck" CHECK (
    ("mark" IS NULL OR "mark" > 0) AND ("index_price" IS NULL OR "index_price" > 0)
  ),
  CONSTRAINT "funding_rate_samples_gap_ck" CHECK (
    ("mark" IS NOT NULL AND "index_price" IS NOT NULL) = ("gap_reason" IS NULL)
  )
);

-- One row per funding period the computer looked at. 'published' is closed and immutable: a replay returns the
-- stored rate. 'refused' and 'paused' are retried on the next run and keep the latest reason and an attempt count.
CREATE TABLE IF NOT EXISTS "trade"."funding_rate_periods" (
  "period_id"       text        PRIMARY KEY,
  "market_id"       text        NOT NULL,
  "period_start"    timestamptz,
  "period_end"      timestamptz,
  "status"          text        NOT NULL,
  "code"            text,
  "message"         text,
  "rate"            text,
  "premium"         text,
  "base_component"  text,
  "cap"             text,
  "clamped"         boolean     NOT NULL DEFAULT false,
  "params_version"  bigint,
  "inputs"          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "attempts"        integer     NOT NULL DEFAULT 1,
  "computed_at"     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "funding_rate_periods_status_ck" CHECK ("status" IN ('published', 'refused', 'paused')),
  CONSTRAINT "funding_rate_periods_shape_ck" CHECK (
    ("status" = 'published' AND "rate" IS NOT NULL AND "code" IS NULL AND "period_start" IS NOT NULL AND "period_end" IS NOT NULL)
    OR ("status" <> 'published' AND "rate" IS NULL AND "code" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "funding_rate_periods_market_idx"
  ON "trade"."funding_rate_periods" ("market_id", "computed_at" DESC);

CREATE OR REPLACE FUNCTION trade.funding_rate_period_closed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'published' THEN
    RAISE EXCEPTION 'a funding rate period is closed once published' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS funding_rate_periods_closed ON "trade"."funding_rate_periods";
CREATE TRIGGER funding_rate_periods_closed
  BEFORE UPDATE OR DELETE ON "trade"."funding_rate_periods"
  FOR EACH ROW EXECUTE FUNCTION trade.funding_rate_period_closed();
