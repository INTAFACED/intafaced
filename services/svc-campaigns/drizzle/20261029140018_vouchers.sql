-- J-campaigns-16 #9, CM-vouchers-coupons-01 and CM-campaign-types-01 T-3: a voucher of a voucher campaign keeps the
-- revision it was issued under and that revision's reward as its face value. A later approved revision changes the
-- vouchers issued after it, never one already published. The face value is a counter, not a balance: nothing is held
-- for a voucher, and a cash redemption (J-campaigns-08) goes through the reward saga under its own key.

CREATE TABLE IF NOT EXISTS campaigns.vouchers (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  code text NOT NULL,
  -- The business key, `voucher:issue:<campaign>:<code>`: the same issue again returns this row.
  issue_key text NOT NULL UNIQUE,
  revision integer NOT NULL,
  face_asset text NOT NULL,
  face_amount numeric(38, 18) NOT NULL,
  state text NOT NULL DEFAULT 'published',
  issued_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vouchers_code_uq UNIQUE (campaign_id, code),
  CONSTRAINT vouchers_revision_fk FOREIGN KEY (campaign_id, revision) REFERENCES campaigns.campaign_revisions (campaign_id, revision),
  CONSTRAINT vouchers_face_ck CHECK (face_amount > 0),
  CONSTRAINT vouchers_state_ck CHECK (
    state IN ('generated', 'published', 'active', 'claimed', 'partially_used', 'used', 'expired', 'forfeited', 'deactivated')
  )
);

CREATE INDEX IF NOT EXISTS vouchers_campaign_idx ON campaigns.vouchers (campaign_id, created_at);
