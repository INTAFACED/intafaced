-- svc-ledger · a balance snapshot names the chain tip it locked
-- Reversal: 0015_snapshot_chain_tip.down.sql
--
-- writeSnapshots stamped as_of when the function was entered, before the
-- balance read, and stored no chain tip. runScheduledReconciliation released
-- any claim on the book between the proof and that insert, so a commit in
-- the gap was written as the anchor.
--
-- chain_tip_seq / chain_tip_hash are that locked tip. through_entry_id is the
-- replay cutoff, not the tip hash, and this migration does not treat it as one.
--
-- Nullable on purpose. Rows already stored have no recorded tip, and inventing
-- a seq or a hash for them would name a tip the snapshot never locked. New
-- writes always fill both from the row held FOR UPDATE.

ALTER TABLE "ledger"."balance_snapshots"
  ADD COLUMN "chain_tip_seq" bigint,
  ADD COLUMN "chain_tip_hash" text;
