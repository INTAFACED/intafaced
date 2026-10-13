-- Reverse 0013_p2p_dispute_ruling_frozen.sql
--
-- Afterwards a resolved dispute can have its resolution rewritten from release
-- to refund, or from refund to release, while status, moderator_id, and
-- resolved_at stay populated. The evidence trigger still returns immediately
-- when evidence is unchanged, so it does not freeze the ruling. After the
-- escrow has moved, that rewrite names the opposite party from the one who
-- was paid. This file exists so the migration is reversible (§14 DoD 1).
-- Do not run it against a database holding a settled dispute.

DROP TRIGGER IF EXISTS "p2p_disputes_resolved_ruling_frozen_trg" ON "p2p"."p2p_disputes";
DROP FUNCTION IF EXISTS "p2p"."p2p_disputes_resolved_ruling_frozen"();
