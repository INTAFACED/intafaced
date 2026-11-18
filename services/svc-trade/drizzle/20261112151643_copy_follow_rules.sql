-- trade.copy_follows.copy_rules · the follower's own copy rules (J-copy-bots-otc-02 #1 to #3; src/copy/follow-rules.ts):
-- the sizing mode (locked once the follow is made), smart sync's two readings, the most per contract and the most per
-- owner day. Reversal: 20261112151643_copy_follow_rules.down.sql
--
-- Limits, never money: decimal strings in the follow's quote asset; an absent key means not set. Follows made before
-- this column read as fixed amount with no such caps.

ALTER TABLE trade.copy_follows
  ADD COLUMN IF NOT EXISTS copy_rules jsonb NOT NULL DEFAULT '{}'::jsonb;
