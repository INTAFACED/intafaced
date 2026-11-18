-- Reverses 20261117220744_self_freeze_applied.sql. Revoked permissions stay revoked: dropping the record restores none.
DROP TABLE IF EXISTS "agents"."self_freezes_applied";
