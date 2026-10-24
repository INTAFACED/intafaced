-- svc-notify · fee change notices (SP-fees-vip-04, J-cex-spot-10 #10)
-- Reversal: 0035_notify_fee_change_notices.down.sql
--
-- A `fee_change` notice announces a new trading fee schedule version: its starts_at is the time the version takes
-- effect, and it has no end. It changes no rate; svc-trade's stored version does, at that time.
ALTER TABLE notify.notices DROP CONSTRAINT IF EXISTS notices_kind_ck;
ALTER TABLE notify.notices ADD CONSTRAINT notices_kind_ck
  CHECK (kind IN ('announcement', 'maintenance', 'incident', 'changelog', 'fee_change'));
ALTER TABLE notify.notices DROP CONSTRAINT IF EXISTS notices_fee_change_effective_ck;
ALTER TABLE notify.notices ADD CONSTRAINT notices_fee_change_effective_ck
  CHECK (kind <> 'fee_change' OR (starts_at IS NOT NULL AND ends_at IS NULL));
