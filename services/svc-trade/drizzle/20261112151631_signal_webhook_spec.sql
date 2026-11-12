-- intafaced:destructive relaxes NOT NULL on symbol, venue_owner, place_grant and grant_expires_at so a notification URL can hold none of them; signal_webhooks_kind_fields_ck keeps all four required on every order webhook
-- trade.signals · the webhook order forms, pause and the failure count, and the notification URL
-- (CB-bots-api-signal-02 and -03, J-copy-bots-otc-20 #4 to #7)
-- Reversal: 20261112151631_signal_webhook_spec.down.sql
--
-- An order webhook now counts the alerts in a row whose every order was refused; at the owner's count
-- (TRADE_SIGNAL_FAILURE_COUNT) it ends, once, and says why. A person may pause, resume or end it themselves.
-- A notification URL is a second kind of webhook with its own token: its alerts become one in-app notice each and never
-- an order, so it names no market, venue account or place grant.

ALTER TABLE trade.signal_webhooks
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'order',
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ended_reason text,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz;

ALTER TABLE trade.signal_webhooks DROP CONSTRAINT IF EXISTS signal_webhooks_kind_ck;
ALTER TABLE trade.signal_webhooks ADD CONSTRAINT signal_webhooks_kind_ck CHECK (kind IN ('order', 'notify'));
ALTER TABLE trade.signal_webhooks DROP CONSTRAINT IF EXISTS signal_webhooks_failures_ck;
ALTER TABLE trade.signal_webhooks ADD CONSTRAINT signal_webhooks_failures_ck CHECK (consecutive_failures >= 0);
-- A webhook ended before this migration had no reason kept; none was ended by the person or by failures yet.
UPDATE trade.signal_webhooks SET ended_reason = 'owner', ended_at = updated_at WHERE state = 'ended' AND ended_reason IS NULL;
ALTER TABLE trade.signal_webhooks DROP CONSTRAINT IF EXISTS signal_webhooks_ended_ck;
ALTER TABLE trade.signal_webhooks ADD CONSTRAINT signal_webhooks_ended_ck CHECK (
  (state = 'ended') = (ended_reason IS NOT NULL) AND (ended_reason IS NULL OR ended_reason IN ('failures', 'owner'))
);

-- A notification URL has no market, venue account or place grant; an order webhook has all three.
ALTER TABLE trade.signal_webhooks ALTER COLUMN symbol DROP NOT NULL;
ALTER TABLE trade.signal_webhooks ALTER COLUMN venue_owner DROP NOT NULL;
ALTER TABLE trade.signal_webhooks ALTER COLUMN place_grant DROP NOT NULL;
ALTER TABLE trade.signal_webhooks ALTER COLUMN grant_expires_at DROP NOT NULL;
ALTER TABLE trade.signal_webhooks DROP CONSTRAINT IF EXISTS signal_webhooks_kind_fields_ck;
ALTER TABLE trade.signal_webhooks ADD CONSTRAINT signal_webhooks_kind_fields_ck CHECK (
  (kind = 'order' AND symbol IS NOT NULL AND venue_owner IS NOT NULL AND place_grant IS NOT NULL AND grant_expires_at IS NOT NULL)
  OR (kind = 'notify' AND symbol IS NULL AND venue_owner IS NULL AND place_grant IS NULL AND grant_expires_at IS NULL)
);
