-- svc-protocol · prune spent challenges that never got a proof (D-launch-listing-01 follow-up)
-- Reversal: 20261030193000_protocol_listing_spent_expiry.down.sql
--
-- A failed check spends its challenge with no proof row. Once expired, such a row refuses nothing a missing row would not
-- (an unknown nonce refuses too), so pruning deletes it. This partial index lets pruning find spent rows by expiry
-- without reading the whole table; a proven challenge is kept for its proof.
CREATE INDEX IF NOT EXISTS "listing_challenges_spent_expiry_idx" ON "protocol"."listing_challenges" ("expires_at") WHERE "used_at" IS NOT NULL;
