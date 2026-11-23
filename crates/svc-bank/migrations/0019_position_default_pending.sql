-- An earn claim exists before the ledger post. 0001 added `pending` so that
-- claim can be stored, and left `earn_positions.status` DEFAULT 'active'.
-- An insert that omits status is then interest-eligible before the post.
--
-- SET DEFAULT only. Stored rows keep the status they already have.
-- Principal is untouched. No ledger id is written.
--
-- Reversal: 0019_position_default_pending.down.sql

ALTER TABLE "bank"."earn_positions" ALTER COLUMN "status" SET DEFAULT 'pending';
