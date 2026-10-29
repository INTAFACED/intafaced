-- Refuses while a campaign holds a library rule: its copy would outlive the library it names.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.campaigns WHERE participation ? 'rule' AND participation->'rule' <> 'null'::jsonb) THEN
    RAISE EXCEPTION 'campaigns: a campaign holds a library rule; remove it before reversing this migration';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.rule_library;
