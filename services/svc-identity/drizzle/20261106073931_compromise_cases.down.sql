-- Reverses 20261106073931_compromise_cases.sql. Cases, their reviews and notes go; the freezes and revoked sessions and
-- keys they caused stay as they are.
DROP TABLE IF EXISTS "identity"."compromise_case_notes";
DROP TABLE IF EXISTS "identity"."compromise_case_reviews";
DROP TABLE IF EXISTS "identity"."compromise_cases";
