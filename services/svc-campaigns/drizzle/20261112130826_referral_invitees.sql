-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so it carries the new column
-- J-campaigns-06 #1 #2, CM-referral-02: a referral campaign's programme (sides, criteria, each side's reward), part of its
-- definition and so of each revision; each invitee, kept once from `identity.referral.created` under the referral
-- programme live then (its terms copied, so a later revision never changes what an invitee was measured by); and the
-- invitee's own verify, deposit and spot fill events, each kept once by its event id, that count toward qualifying.
-- Qualified is written once. No balance and no money here: CM-referral-03 pays the rewards. Reversal: the .down.sql.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS referral jsonb;

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;

-- One row per invitee (an account attaches to one referrer once). `campaign_id` null: no referral programme was live.
CREATE TABLE IF NOT EXISTS campaigns.referral_invitees (
  invitee_id text PRIMARY KEY,
  referrer_id text NOT NULL,
  attached_at timestamptz NOT NULL,
  campaign_id text REFERENCES campaigns.campaigns (id),
  revision integer,
  terms jsonb,
  qualified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_invitees_terms_ck CHECK ((campaign_id IS NULL) = (terms IS NULL))
);
CREATE INDEX IF NOT EXISTS referral_invitees_referrer_idx ON campaigns.referral_invitees (referrer_id, attached_at, invitee_id);

-- The invitee's events that count, each once by its event id. `amount`: a deposit's amount or a fill's quote amount, in
-- `asset`; a verification keeps its tier in `tier`.
CREATE TABLE IF NOT EXISTS campaigns.referral_events (
  invitee_id text NOT NULL REFERENCES campaigns.referral_invitees (invitee_id),
  kind text NOT NULL,
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  asset text,
  amount numeric(38, 18),
  tier text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitee_id, kind, event_id),
  CONSTRAINT referral_events_kind_ck CHECK (kind IN ('verified', 'deposit', 'fill'))
);
