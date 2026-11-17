-- Reversal of the matching up migration: nothing to restore. A rule it deleted could never pass the transport cap
-- that follows it, so it is not put back; the owner publishes a rule within the cap.
-- The statement below changes nothing; it is here because a reversal file must hold SQL (`tooling/ci/migration-check.mjs`).

SELECT 1;
