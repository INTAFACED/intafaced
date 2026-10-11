-- This schema lives ONLY in the independent archive database, never in prospect restores.
CREATE TABLE IF NOT EXISTS ops.erasure_archive_packets (
 intent_id uuid PRIMARY KEY,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 generation bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ciphertext bytea NOT NULL,
 iv bytea NOT NULL CHECK(octet_length(iv)=12),
 tag bytea NOT NULL CHECK(octet_length(tag)=16)
);
CREATE OR REPLACE FUNCTION ops.archive_packet_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ops.crm.archive_packet_immutable'; END $$;
DROP TRIGGER IF EXISTS archive_packet_immutable ON ops.erasure_archive_packets;
CREATE TRIGGER archive_packet_immutable BEFORE UPDATE OR DELETE ON ops.erasure_archive_packets
 FOR EACH ROW EXECUTE FUNCTION ops.archive_packet_immutable();
CREATE TABLE IF NOT EXISTS ops.erasure_archive_head (
 singleton boolean PRIMARY KEY CHECK(singleton),
 generation bigint NOT NULL CHECK(generation>=0),
 packet_count bigint NOT NULL CHECK(packet_count>=0)
);
INSERT INTO ops.erasure_archive_head VALUES(true,0,0) ON CONFLICT DO NOTHING;
