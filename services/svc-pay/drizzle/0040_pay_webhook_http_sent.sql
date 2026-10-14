-- A claimed webhook whose POST already left must not be claimed again when
-- the 60s lease expires before markDelivered commits.
--
-- claimDue only advances next_attempt_at. A second worker whose clock is past
-- that lease sees status still pending and POSTs the payment JSON again.
-- http_sent_at is written before the request is handed to the network. claimDue
-- skips those rows. A crash before that write leaves the column null, so lease
-- expiry still retries an attempt that never left. markRetry clears it so a
-- non-2xx or a refused redirect can be attempted again later.
-- Not money — a delivery timestamp only.

ALTER TABLE "pay"."merchant_webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "http_sent_at" timestamptz;
