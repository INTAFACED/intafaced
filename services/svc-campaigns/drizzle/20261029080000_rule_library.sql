-- J-campaigns-16 #4, CM-eligibility-rules-02 (ENGINE EL-4): the rule library. Each save of a name is its next revision;
-- a campaign keeps a copy of the revision it took, so an edit here never changes a campaign already using the rule.

CREATE TABLE IF NOT EXISTS campaigns.rule_library (
  name text NOT NULL,
  revision integer NOT NULL,
  tree jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_library_revision_ck CHECK (revision > 0)
);

-- One revision number per name, whatever its case.
CREATE UNIQUE INDEX IF NOT EXISTS rule_library_name_revision_uq ON campaigns.rule_library (lower(name), revision);
