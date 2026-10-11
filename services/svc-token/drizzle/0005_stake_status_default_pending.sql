-- L351: an insert that omits token.stakes.status must not be yield-eligible.
--
-- 0000 created the column NOT NULL DEFAULT 'active' while stake_status already
-- included 'pending'. 0001 only adds that enum value again. migrate.ts records
-- applied files in token.__migrations and skips them, and CREATE TABLE IF NOT
-- EXISTS will not change a default on a book that already applied 0000.
--
-- This sets the default only. Existing active rows stay active — a funded
-- stake is not rewritten to pending, and no principal is written here.

ALTER TABLE "token"."stakes" ALTER COLUMN "status" SET DEFAULT 'pending';
