-- BK-pots-02 (J-bank-07 #2): a pot's owner can ask to unlock it before its lock date. The ask waits out the owner-set
-- window (BANK_SPACE_UNLOCK_WAIT_HOURS) and then the pot is unlocked; until then debits still refuse bank.space_locked.
-- `unlock_requested_at` is when the owner confirmed the ask, `unlocks_at` when the lock ends early (never later than
-- `locked_until`). Both are set together or both are empty. A new lock clears them.
-- Reversal: 20261024153323_space_early_unlock.down.sql

ALTER TABLE "bank"."spaces"
  ADD COLUMN IF NOT EXISTS "unlock_requested_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "unlocks_at" timestamptz;

ALTER TABLE "bank"."spaces"
  DROP CONSTRAINT IF EXISTS "spaces_early_unlock_ck",
  ADD CONSTRAINT "spaces_early_unlock_ck" CHECK (
    ("unlock_requested_at" IS NULL AND "unlocks_at" IS NULL)
    OR ("unlock_requested_at" IS NOT NULL AND "unlocks_at" IS NOT NULL AND "locked_until" IS NOT NULL
        AND "unlocks_at" >= "unlock_requested_at" AND "unlocks_at" <= "locked_until")
  );
