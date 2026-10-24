-- Eligibility review requests (CM-eligibility-rules-01, ENGINE EL-6): a customer a campaign's rules refuse may ask once
-- per campaign for a person to look again. Reversal: the matching .down.sql.
--
-- A request holds the generic rule that refused, never identity's answer itself: identity is read per check and not
-- copied here. The operator queue that answers a request is J-campaigns-16.

CREATE TABLE IF NOT EXISTS campaigns.eligibility_reviews (
  review_key text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  account_id text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eligibility_reviews_one_per_account UNIQUE (campaign_id, account_id),
  CONSTRAINT eligibility_reviews_key_ck CHECK (review_key = 'campaign:review:' || campaign_id || ':' || account_id),
  CONSTRAINT eligibility_reviews_reason_ck CHECK (reason IN ('not_eligible', 'region_blocked')),
  CONSTRAINT eligibility_reviews_state_ck CHECK (state IN ('requested'))
);

CREATE INDEX IF NOT EXISTS eligibility_reviews_queue_idx ON campaigns.eligibility_reviews (state, created_at);
