-- Refuses while a welcome campaign exists: the type check would no longer hold, and its rewards name it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.campaigns WHERE type = 'welcome') THEN
    RAISE EXCEPTION 'campaigns: a welcome campaign exists; it is never dropped by reversing this migration';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.welcome_events;
DROP TABLE IF EXISTS campaigns.welcome_accounts;
ALTER TABLE campaigns.campaigns DROP CONSTRAINT IF EXISTS campaigns_type_ck;
ALTER TABLE campaigns.campaigns ADD CONSTRAINT campaigns_type_ck CHECK (type IN ('referral', 'task', 'voucher', 'competition',
  'milestone', 'draw', 'pool', 'distribution', 'trial_pass', 'gift_card', 'points'));
