-- intafaced:destructive — reversal of 0035_notify_fee_change_notices.sql
-- Fee change notices are removed first: the kind check without them would refuse those rows.
ALTER TABLE notify.notices DISABLE TRIGGER notice_published_immutable;
DELETE FROM notify.notice_approval_uses WHERE notice_id IN (SELECT id FROM notify.notices WHERE kind = 'fee_change');
DELETE FROM notify.notices WHERE kind = 'fee_change';
ALTER TABLE notify.notices ENABLE TRIGGER notice_published_immutable;
ALTER TABLE notify.notices DROP CONSTRAINT IF EXISTS notices_fee_change_effective_ck;
ALTER TABLE notify.notices DROP CONSTRAINT IF EXISTS notices_kind_ck;
ALTER TABLE notify.notices ADD CONSTRAINT notices_kind_ck CHECK (kind IN ('announcement', 'maintenance', 'incident', 'changelog'));

-- The published-row trigger as 0034 left it.
CREATE OR REPLACE FUNCTION notify.notice_published_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
      OR OLD.kind IS DISTINCT FROM NEW.kind
      OR OLD.title IS DISTINCT FROM NEW.title
      OR OLD.body IS DISTINCT FROM NEW.body
      OR OLD.published_at IS DISTINCT FROM NEW.published_at
      OR OLD.author_id IS DISTINCT FROM NEW.author_id
      OR OLD.version IS DISTINCT FROM NEW.version
      OR OLD.client_request_id IS DISTINCT FROM NEW.client_request_id
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.impact IS DISTINCT FROM NEW.impact
      OR OLD.components IS DISTINCT FROM NEW.components
      OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
      OR OLD.resolves IS DISTINCT FROM NEW.resolves
      OR OLD.changelog IS DISTINCT FROM NEW.changelog
      OR OLD.asset IS DISTINCT FROM NEW.asset
      OR OLD.network IS DISTINCT FROM NEW.network
      OR OLD.phase IS DISTINCT FROM NEW.phase
      OR OLD.reminder_offsets IS DISTINCT FROM NEW.reminder_offsets
      OR OLD.category IS DISTINCT FROM NEW.category
      OR OLD.audience IS DISTINCT FROM NEW.audience
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
