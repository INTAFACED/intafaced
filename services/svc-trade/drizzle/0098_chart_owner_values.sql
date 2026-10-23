-- Charts module owner values (C-ops-04, LD-14). Blank is NULL: "not set", never a default number.
-- Scalars: one append-only row per version, a full snapshot of the five counts; the highest version is current.
-- Data class: one append-only row per (market symbol, version); the highest version per symbol is current, NULL is not set.
-- Reversal: 0098_chart_owner_values.down.sql
CREATE TABLE IF NOT EXISTS trade.chart_owner_values (
  version bigint PRIMARY KEY CHECK (version >= 1),
  compare_cap integer CHECK (compare_cap IS NULL OR compare_cap BETWEEN 1 AND 50),
  chart_count_limit integer CHECK (chart_count_limit IS NULL OR chart_count_limit BETWEEN 1 AND 64),
  drawing_cap integer CHECK (drawing_cap IS NULL OR drawing_cap BETWEEN 1 AND 10000),
  brush_point_cap integer CHECK (brush_point_cap IS NULL OR brush_point_cap BETWEEN 1 AND 100000),
  delayed_boundary_seconds integer CHECK (delayed_boundary_seconds IS NULL OR delayed_boundary_seconds BETWEEN 1 AND 86400),
  operator_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS chart_owner_values_append_only ON "trade"."chart_owner_values";
CREATE TRIGGER chart_owner_values_append_only
  BEFORE UPDATE OR DELETE ON "trade"."chart_owner_values"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

CREATE TABLE IF NOT EXISTS trade.chart_data_class (
  symbol text NOT NULL CHECK (char_length(symbol) BETWEEN 1 AND 64),
  version bigint NOT NULL CHECK (version >= 1),
  data_class text CHECK (data_class IS NULL OR data_class IN ('real_time', 'delayed', 'end_of_day')),
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (symbol, version)
);

DROP TRIGGER IF EXISTS chart_data_class_append_only ON "trade"."chart_data_class";
CREATE TRIGGER chart_data_class_append_only
  BEFORE UPDATE OR DELETE ON "trade"."chart_data_class"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();
