-- Restores the pre-0005 column default. Does not rewrite row status.

ALTER TABLE "token"."stakes" ALTER COLUMN "status" SET DEFAULT 'active';
