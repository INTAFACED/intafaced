-- intafaced:destructive — reversal of 0000_blueprint_init.sql
--
-- This drops every Identity Blueprint, every crew and every mentor pairing.
-- It exists so the migration is provably reversible in CI against a scratch
-- schema (§14) — not because it should ever run against a database with real
-- Blueprints in it. A profile is not recoverable from anywhere else: the
-- session inputs that produced it were never stored (§10), so re-deriving one
-- means putting the user back through onboarding.
--
-- Order matters: crew_members and match_runs both reference crews.
--
-- The "blueprint" schema itself is left in place — the bootstrap owns it, not
-- this migration (§2), and this role has no DROP SCHEMA privilege anyway.

DROP TABLE IF EXISTS "blueprint"."mentor_matches";
DROP TABLE IF EXISTS "blueprint"."match_runs";
DROP TABLE IF EXISTS "blueprint"."crew_members";
DROP TABLE IF EXISTS "blueprint"."crews";
DROP TABLE IF EXISTS "blueprint"."blueprints";

DROP TYPE IF EXISTS "blueprint"."mentor_match_status";
DROP TYPE IF EXISTS "blueprint"."crew_role";
DROP TYPE IF EXISTS "blueprint"."blueprint_visibility";
