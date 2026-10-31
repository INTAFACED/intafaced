-- W-withdraw-06 (J-wallet-05 #8): a send out of the platform settles only once the chain reaches the owner-set depth
-- (PAY_MIN_CONFIRMATIONS). Until then its accepted attempt records the depth the chain last showed, so the person reads
-- `broadcast` (none yet) or `confirming` (some, not enough). A receipt, never a balance: the hold stays until the settle.
-- NULL is "not read": every attempt from before this column, and every rail that settles on acceptance.
-- Reversal: the matching .down.sql

ALTER TABLE pay.withdrawal_rail_attempts ADD COLUMN confirmations integer CHECK (confirmations >= 0);
