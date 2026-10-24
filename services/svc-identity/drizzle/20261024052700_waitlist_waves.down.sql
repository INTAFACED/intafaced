-- Reverses 20261024052700_waitlist_waves.sql. Waitlist entries stay; the waves and their release records go.
DROP TABLE IF EXISTS "identity"."waitlist_releases";
DROP TABLE IF EXISTS "identity"."waitlist_waves";
DROP INDEX IF EXISTS "identity"."waitlist_entries_rank_idx";
