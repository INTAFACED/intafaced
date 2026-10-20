-- Venue cost notes for the unit-economics report: append-only, a later version of the
-- same (period, category) supersedes the earlier one and the earlier row stays.
CREATE TABLE ops.venue_cost_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 period text NOT NULL CHECK(period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 category text NOT NULL CHECK(category IN ('liquidity','insurance_default_capital','custody','data','support','compliance','infrastructure')),
 version integer NOT NULL CHECK(version >= 1),
 amount numeric(38,18) NOT NULL CHECK(amount >= 0),
 asset text NOT NULL CHECK(asset ~ '^[A-Z0-9]{2,12}$'),
 source_note text NOT NULL CHECK(length(source_note) BETWEEN 1 AND 500),
 entered_by text NOT NULL,
 approver_id text NOT NULL,
 supersedes_id uuid REFERENCES ops.venue_cost_entries(id),
 entered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (period, category, version)
);
CREATE INDEX venue_cost_entries_period_idx ON ops.venue_cost_entries (period, category, version);
CREATE FUNCTION ops.venue_cost_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.venue_cost_entry_immutable';
END $$;
CREATE TRIGGER venue_cost_entries_append_only BEFORE UPDATE OR DELETE ON ops.venue_cost_entries FOR EACH ROW EXECUTE FUNCTION ops.venue_cost_entries_append_only();
