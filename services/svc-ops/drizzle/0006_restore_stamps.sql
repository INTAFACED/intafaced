-- Joint-restore stamps are append-only rows; a retry with the same key finds its row.
CREATE TABLE ops.restore_stamps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 200),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 service text NOT NULL,
 kind text NOT NULL,
 watermark text NOT NULL CHECK(length(watermark) BETWEEN 1 AND 256),
 recorded_by text NOT NULL,
 approver_id text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX restore_stamps_recorded_idx ON ops.restore_stamps (recorded_at, id);
CREATE FUNCTION ops.restore_stamps_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.restore_stamp_immutable';
END $$;
CREATE TRIGGER restore_stamps_append_only BEFORE UPDATE OR DELETE ON ops.restore_stamps FOR EACH ROW EXECUTE FUNCTION ops.restore_stamps_append_only();
