-- trade.copy · stored risk-disclosure acceptance (TRD-0773)
-- Reversal: 0060_copy_disclosure_acceptances.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by COPYGATE before this file was written.
--
-- The disclosure wording is owner content (TRADE_COPY_DISCLOSURE_LAW). This table
-- stores who accepted which version. It does not store the text and does not
-- invent a placeholder. One row per follower and version. A replay returns the
-- first row. Append-only: update and delete are refused.

CREATE OR REPLACE FUNCTION trade.copy_disclosure_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'copy disclosure acceptance is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TABLE IF NOT EXISTS trade.copy_disclosure_acceptances (
  follower_id text NOT NULL,
  version text NOT NULL,
  accepted_at timestamptz NOT NULL,
  client_accept_id text NOT NULL,
  PRIMARY KEY (follower_id, version)
);

DROP TRIGGER IF EXISTS copy_disclosure_acceptances_append_only ON trade.copy_disclosure_acceptances;
CREATE TRIGGER copy_disclosure_acceptances_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_disclosure_acceptances
  FOR EACH ROW EXECUTE FUNCTION trade.copy_disclosure_append_only();
