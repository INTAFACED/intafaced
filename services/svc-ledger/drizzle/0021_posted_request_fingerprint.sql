-- svc-ledger · the posted claim remembers what the post MOVED
-- Reversal: 0021_posted_request_fingerprint.down.sql
--
-- A reused idempotency key with a different body used to be answered with the
-- OLD transaction, so the caller recorded success for money that never moved.
-- The claim now stores a digest of what the post moves (module, reason and each
-- entry's account, direction and amount; not meta). A replay carrying a
-- different digest is refused with ledger.idempotency_conflict.
--
-- Nullable on purpose: rows booked before this migration have no digest and
-- keep the old behaviour. The column is added, never backfilled, because the
-- append-only trigger on ledger_posted_keys refuses UPDATE and a digest cannot
-- be recomputed from journal rows without the caller's original body.

ALTER TABLE "ledger"."ledger_posted_keys" ADD COLUMN IF NOT EXISTS "request_fingerprint" text;
