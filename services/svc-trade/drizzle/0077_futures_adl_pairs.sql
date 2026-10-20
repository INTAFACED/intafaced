-- trade.futures_adl_pairs · one ADL pairing of a bankrupt position with one opposite-side position
-- Reversal: 0077_futures_adl_pairs.down.sql
--
-- docs/adr/2026-10-20-futures-matched-traders.md section 6. When the insurance fund cannot cover a bankrupt
-- position, ADL closes `size` of it against `size` of an opposite-side position at the bankruptcy price. The row is
-- the plan, committed before anything posts: the bankrupt's loss leg, the candidate's margin release and the
-- candidate's profit are all rebuilt from these columns, so a replay after a crash posts the same bodies under the
-- same keys. It is never a balance: the ledger postings are the money, and `state` only says whether both
-- position rows have caught up with them.

CREATE TABLE IF NOT EXISTS "trade"."futures_adl_pairs" (
  "pair_id"                     text            PRIMARY KEY,
  "ordinal"                     integer         NOT NULL,
  "bankrupt_position_id"        uuid            NOT NULL,
  "bankrupt_user_id"            uuid            NOT NULL,
  "candidate_position_id"       uuid            NOT NULL,
  "candidate_user_id"           uuid            NOT NULL,
  "asset_id"                    text            NOT NULL,
  "size"                        numeric(38, 18) NOT NULL,
  "bankruptcy_price"            numeric(38, 18) NOT NULL,
  "bankrupt_margin_taken"       numeric(38, 18) NOT NULL,
  "bankrupt_initial_taken"      numeric(38, 18) NOT NULL,
  "candidate_margin_released"   numeric(38, 18) NOT NULL,
  "candidate_initial_released"  numeric(38, 18) NOT NULL,
  "candidate_release_sequence"  integer         NOT NULL,
  "candidate_profit"            numeric(38, 18) NOT NULL,
  "disclosure_event_id"         text            NOT NULL,
  "state"                       text            NOT NULL DEFAULT 'planned',
  "created_at"                  timestamptz     NOT NULL DEFAULT now(),
  "applied_at"                  timestamptz,
  CONSTRAINT "futures_adl_pairs_size_ck" CHECK ("size" > 0),
  CONSTRAINT "futures_adl_pairs_price_ck" CHECK ("bankruptcy_price" > 0),
  CONSTRAINT "futures_adl_pairs_amounts_ck" CHECK (
    "bankrupt_margin_taken" >= 0 AND "bankrupt_initial_taken" >= 0 AND "candidate_margin_released" >= 0
    AND "candidate_initial_released" >= 0 AND "candidate_profit" > 0
  ),
  CONSTRAINT "futures_adl_pairs_sides_ck" CHECK ("bankrupt_position_id" <> "candidate_position_id"),
  CONSTRAINT "futures_adl_pairs_state_ck" CHECK ("state" IN ('planned', 'applied')),
  CONSTRAINT "futures_adl_pairs_applied_at_ck" CHECK (("state" = 'applied') = ("applied_at" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "futures_adl_pairs_ordinal_idx"
  ON "trade"."futures_adl_pairs" ("bankrupt_position_id", "ordinal");
-- One unfinished pair per position on either side: the pair is replayed before anything else touches either row.
CREATE UNIQUE INDEX IF NOT EXISTS "futures_adl_pairs_bankrupt_planned_idx"
  ON "trade"."futures_adl_pairs" ("bankrupt_position_id") WHERE "state" = 'planned';
CREATE UNIQUE INDEX IF NOT EXISTS "futures_adl_pairs_candidate_planned_idx"
  ON "trade"."futures_adl_pairs" ("candidate_position_id") WHERE "state" = 'planned';
CREATE INDEX IF NOT EXISTS "futures_adl_pairs_candidate_idx"
  ON "trade"."futures_adl_pairs" ("candidate_position_id");
