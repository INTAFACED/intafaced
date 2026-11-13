-- trade.user_venue_actions · our good-till-date's due cancels (J-cex-spot-03 #7; project-state #2260)
-- Reversal: 20261113043842_user_venue_actions_good_till_date.down.sql
--
-- A good-till-date order is a good-till-cancelled order on the venue plus a cancel the owner's wallet signed before the
-- order, stored under `gtd:<clientOrderKey>` with its send time (`prepared.intent.sendAt`, epoch ms) as its nonce. The
-- door's sweep sends each one at its time. This index finds the signed ones not yet answered for good, by send time.
-- Nothing here is a balance: the venue holds the order, its lock and its cancel.
CREATE INDEX IF NOT EXISTS user_venue_actions_gtd_due_idx
  ON trade.user_venue_actions (((prepared #>> '{intent,sendAt}')::bigint))
  WHERE kind = 'cancel_order' AND business_key LIKE 'gtd:%' AND signature IS NOT NULL
    AND (last_outcome IS NULL OR last_outcome->>'definite' IS DISTINCT FROM 'true');
