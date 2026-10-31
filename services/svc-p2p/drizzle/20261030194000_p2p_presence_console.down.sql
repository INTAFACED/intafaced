-- Reverses 20261030194000_p2p_presence_console.sql: every maker's ads follow their own status again.
DROP TABLE IF EXISTS "p2p"."offer_bulk_runs";
DROP FUNCTION IF EXISTS "p2p"."maker_on_board"(text, timestamptz);
DROP FUNCTION IF EXISTS "p2p"."presence_open"(text, jsonb, timestamptz);
DROP TABLE IF EXISTS "p2p"."merchant_presence";
