-- The reason codes a hide or delist may name (D-order-controls-04). Reversal: 0013_protocol_reason_codes.down.sql
--
-- Admin-editable and append-only: every edit is a new row with who made it and when; the list in force is the newest row.
-- No row means no admin edit has been made, and the service falls back to its setting or its built-in default.
CREATE TABLE ops.protocol_reason_code_changes (
 id bigserial PRIMARY KEY,
 codes text[] NOT NULL CHECK(cardinality(codes) BETWEEN 1 AND 50),
 changed_by text NOT NULL CHECK(length(changed_by) BETWEEN 1 AND 200),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ops.protocol_reason_code_changes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.protocol_reason_code_change_immutable';
END $$;
CREATE TRIGGER protocol_reason_code_changes_append_only BEFORE UPDATE OR DELETE ON ops.protocol_reason_code_changes FOR EACH ROW EXECUTE FUNCTION ops.protocol_reason_code_changes_append_only();
