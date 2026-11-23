-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so it carries the new column
-- J-campaigns-12, CM-promotions-events-02: a lucky draw. Its terms are part of the campaign's definition (and so of each
-- revision). The seed is made by svc-campaigns before the draw takes any entry and is kept only here; what anyone sees is
-- its commitment (SHA-256 of the seed). Chances are earned once per venue fill of an entrant's order placed through
-- INTAFACED, keyed by the draw, the venue's own account and fill id, so a fill read again adds nothing; a fill past the
-- cap is kept with no chance. No money here: running, settling and paying a draw wait for the owner's decision on
-- chance-based rewards, and nothing writes a reward intent for a draw. Reversal: the .down.sql.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS draw jsonb;

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;

CREATE TABLE IF NOT EXISTS campaigns.draw_seeds (
  campaign_id text PRIMARY KEY REFERENCES campaigns.campaigns (id),
  -- 32 random bytes, hex. Never read by any door until a draw runs.
  seed text NOT NULL,
  commitment text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draw_seeds_seed_ck CHECK (seed ~ '^[0-9a-f]{64}$'),
  CONSTRAINT draw_seeds_commitment_ck CHECK (commitment ~ '^[0-9a-f]{64}$')
);

-- The last read of the venue's fills for one entrant: when it answered, or why it did not.
CREATE TABLE IF NOT EXISTS campaigns.draw_reads (
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  account_id text NOT NULL,
  user_type text,
  read_at timestamptz,
  unread text,
  PRIMARY KEY (campaign_id, account_id)
);

CREATE TABLE IF NOT EXISTS campaigns.draw_chances (
  campaign_id text NOT NULL,
  account_id text NOT NULL,
  venue_id text NOT NULL,
  venue_account text NOT NULL,
  fill_id text NOT NULL,
  -- What this fill earned: the draw's chances per fill, or fewer (down to 0) where the cap for the user type stopped it.
  chances integer NOT NULL,
  user_type text NOT NULL,
  filled_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, venue_id, venue_account, fill_id),
  FOREIGN KEY (campaign_id, account_id) REFERENCES campaigns.draw_reads (campaign_id, account_id),
  CONSTRAINT draw_chances_ck CHECK (chances >= 0)
);
CREATE INDEX IF NOT EXISTS draw_chances_account_idx ON campaigns.draw_chances (campaign_id, account_id);
