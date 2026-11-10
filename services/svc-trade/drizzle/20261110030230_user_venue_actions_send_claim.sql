-- trade.user_venue_actions · the send claim and the per-account order list (J-developer-05; DV-auth-03, DV-rest-01)
-- Reversal: 20261110030230_user_venue_actions_send_claim.down.sql
--
-- `sending_until`: while a request is sending a key's signed action to the venue it holds this claim, so a second request
-- with the same key at the same moment is answered `idempotency.in_progress` instead of racing it. A claim that ran out
-- (a crashed request) is taken over. It is not a balance and never changes what was prepared or signed (the write-once
-- trigger keeps those).
ALTER TABLE trade.user_venue_actions ADD COLUMN IF NOT EXISTS sending_until timestamptz;

-- GET /api/v1/venue/orders pages one person's signed orders oldest first, by (created_at, business_key).
CREATE INDEX IF NOT EXISTS user_venue_actions_orders_idx
  ON trade.user_venue_actions (user_id, created_at, business_key)
  WHERE kind = 'place_order' AND signature IS NOT NULL;
