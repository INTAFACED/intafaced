-- Reverses 20261113003208_repair_jsonb_string_rows.sql.
-- Deliberately a no-op: the up repair turns a JSON string back into the value it
-- held, and re-encoding it would bring back the bug. Nothing else changed.
SELECT 1;
