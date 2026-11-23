-- Restore the pre-0019 default. Stored rows keep the status they already have.

ALTER TABLE "bank"."earn_positions" ALTER COLUMN "status" SET DEFAULT 'active';
