-- Refuses while a change waits: dropping it would silently lose a revision a founder asked for.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.campaign_changes) THEN
    RAISE EXCEPTION 'campaigns: a campaign change is open; approve or remove it before reversing this migration';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.campaign_revisions;
DROP TABLE IF EXISTS campaigns.campaign_changes;
