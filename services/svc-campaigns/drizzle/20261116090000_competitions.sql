-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so it carries the new column
-- J-campaigns-11, CM-promotions-events-01: a trading competition. Its terms are part of the campaign's definition (and so
-- of each revision). Each entrant holds one seat; two joins for the last seat take one, by the unique seat. Each venue
-- fill of an entrant's order placed through INTAFACED is kept once, by the venue's own fill id and account, so a fill
-- read again adds nothing; a fill with no builder fee of ours is never kept. A milestone is reached once per entrant and
-- tier. A period is settled once: its standings, every prize and what is left of the pool are written together. No
-- balance here: every prize is a reward intent, owed and paid through the reward saga and payer. Reversal: the .down.sql.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS competition jsonb;

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;

-- A competition prize's business key names the campaign, the period and the account: a place prize
-- `competition:<campaign>:<period>:<account>` (period `competition:<period>`), a milestone's with its tier after it
-- (period `competition:<period>:m<tier>`). Every other intent keeps its key.
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_key_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_key_ck CHECK (
  reward_key = 'task:' || campaign_id || ':' || account_id || ':' || period
  OR (period ~ '^voucher:[^:]+:[1-9][0-9]*$'
    AND reward_key = 'voucher:' || split_part(period, ':', 2) || ':' || account_id || ':' || split_part(period, ':', 3))
  OR (period ~ '^competition:[1-9][0-9]*$'
    AND reward_key = 'competition:' || campaign_id || ':' || split_part(period, ':', 2) || ':' || account_id)
  OR (period ~ '^competition:[1-9][0-9]*:m[1-9][0-9]*$'
    AND reward_key = 'competition:' || campaign_id || ':' || split_part(period, ':', 2) || ':' || account_id || ':'
      || split_part(period, ':', 3))
);

CREATE TABLE IF NOT EXISTS campaigns.competition_entries (
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  account_id text NOT NULL,
  seat integer NOT NULL,
  -- The wallet the entrant had connected when they joined, read for them in their own request; prizes are paid to it.
  pay_to_wallet text,
  joined_at timestamptz NOT NULL DEFAULT now(),
  -- The last read of the venue's fills for this entrant: when it answered, or why it did not.
  read_at timestamptz,
  unread text,
  PRIMARY KEY (campaign_id, account_id),
  CONSTRAINT competition_entries_one_seat UNIQUE (campaign_id, seat),
  CONSTRAINT competition_entries_seat_ck CHECK (seat > 0),
  CONSTRAINT competition_entries_wallet_ck CHECK (pay_to_wallet IS NULL OR pay_to_wallet ~ '^0x[0-9a-f]{40}$')
);

CREATE TABLE IF NOT EXISTS campaigns.competition_fills (
  campaign_id text NOT NULL,
  account_id text NOT NULL,
  venue_id text NOT NULL,
  venue_account text NOT NULL,
  fill_id text NOT NULL,
  symbol text NOT NULL,
  notional numeric(38, 18) NOT NULL,
  builder_fee numeric(38, 18) NOT NULL,
  filled_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, venue_id, venue_account, fill_id),
  FOREIGN KEY (campaign_id, account_id) REFERENCES campaigns.competition_entries (campaign_id, account_id),
  CONSTRAINT competition_fills_notional_ck CHECK (notional > 0),
  CONSTRAINT competition_fills_fee_ck CHECK (builder_fee > 0)
);
CREATE INDEX IF NOT EXISTS competition_fills_account_idx ON campaigns.competition_fills (campaign_id, account_id);

CREATE TABLE IF NOT EXISTS campaigns.competition_milestones (
  campaign_id text NOT NULL,
  account_id text NOT NULL,
  tier integer NOT NULL,
  reward_key text NOT NULL UNIQUE,
  reached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, account_id, tier),
  FOREIGN KEY (campaign_id, account_id) REFERENCES campaigns.competition_entries (campaign_id, account_id),
  CONSTRAINT competition_milestones_tier_ck CHECK (tier > 0)
);

CREATE TABLE IF NOT EXISTS campaigns.competition_settlements (
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  period text NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  pool numeric(38, 18) NOT NULL,
  prizes_total numeric(38, 18) NOT NULL,
  remainder numeric(38, 18) NOT NULL,
  -- The final standings and the place winners, as they were settled.
  standings jsonb NOT NULL,
  winners jsonb NOT NULL,
  PRIMARY KEY (campaign_id, period),
  CONSTRAINT competition_settlements_reconcile_ck CHECK (prizes_total >= 0 AND remainder >= 0 AND prizes_total + remainder = pool)
);
