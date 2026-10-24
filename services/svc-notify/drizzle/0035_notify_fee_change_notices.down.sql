-- intafaced:destructive — reversal of 0035_notify_fee_change_notices.sql
-- Fee change notices are removed first: the kind check without them would refuse those rows.
ALTER TABLE notify.notices DISABLE TRIGGER notice_published_immutable;
DELETE FROM notify.notice_approval_uses WHERE notice_id IN (SELECT id FROM notify.notices WHERE kind = 'fee_change');
DELETE FROM notify.notices WHERE kind = 'fee_change';
ALTER TABLE notify.notices ENABLE TRIGGER notice_published_immutable;
ALTER TABLE notify.notices DROP CONSTRAINT IF EXISTS notices_fee_change_effective_ck;
ALTER TABLE notify.notices DROP CONSTRAINT IF EXISTS notices_kind_ck;
ALTER TABLE notify.notices ADD CONSTRAINT notices_kind_ck CHECK (kind IN ('announcement', 'maintenance', 'incident', 'changelog'));
