-- J-campaigns-16 #9, ENGINE LC-5: editing an approved, scheduled, active or paused campaign writes revision n+1 here and
-- leaves the live row as it is. A second founder approves the change, which then replaces the live definition; joins,
-- reward intents and redemptions keep the revision they were made under. One open change per campaign.

CREATE TABLE IF NOT EXISTS campaigns.campaign_changes (
  campaign_id text PRIMARY KEY REFERENCES campaigns.campaigns (id),
  revision integer NOT NULL,
  -- The definition as the update door read it, normalised; read again by the same parser when it is approved.
  definition jsonb NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  created_by text NOT NULL,
  submitted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_changes_state_ck CHECK (state IN ('draft', 'pending_approval')),
  CONSTRAINT campaign_changes_revision_ck CHECK (revision > 1),
  CONSTRAINT campaign_changes_submitted_ck CHECK ((state = 'pending_approval') = (submitted_by IS NOT NULL))
);

-- Every approved revision as it went live: what a join or reward made under revision n was promised.
CREATE TABLE IF NOT EXISTS campaigns.campaign_revisions (
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  revision integer NOT NULL,
  definition jsonb NOT NULL,
  submitted_by text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, revision),
  CONSTRAINT campaign_revisions_second_person_ck CHECK (approved_by <> submitted_by)
);
