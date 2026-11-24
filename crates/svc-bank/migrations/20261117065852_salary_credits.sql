-- Salary paid in by direct deposit (J-bank-30, BK-salary-03). At launch the money is the partner bank's: a salary credit is
-- one pay-in at the partner under `salary:credit:<networkId>`, a split leg is one partner move under
-- `salary:split:<networkId>:<position>`, and a reversal is one partner move under `salary:reverse:<networkId>`. These rows
-- record what the network sent and the partner's own reference for each move, read back once. Nothing is posted to the
-- ledger, and no balance lives here.
--
-- Reversal: the matching .down.sql

CREATE TABLE IF NOT EXISTS "bank"."salary_credits" (
  -- The payroll network's own id for the credit: one network id is one credit, ever.
  "network_id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "account_details_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "originator_name" text NOT NULL,
  "holder_name" text NOT NULL,
  -- pending: the intent, before the partner's answer; received: credited at the partner; returned: refused, nothing
  -- credited; reversed: credited, then taken back by the employer's reversal.
  "state" text NOT NULL,
  "refusal_code" text,
  "credit_move_id" text,
  "reversal_move_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "received_at" timestamptz,
  "reversed_at" timestamptz,
  CONSTRAINT "salary_credits_network_id_ck" CHECK (length("network_id") BETWEEN 1 AND 128),
  CONSTRAINT "salary_credits_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "salary_credits_state_ck" CHECK ("state" IN ('pending', 'received', 'returned', 'reversed')),
  CONSTRAINT "salary_credits_returned_ck" CHECK (
    "state" <> 'returned' OR ("credit_move_id" IS NULL AND "refusal_code" IS NOT NULL)
  ),
  CONSTRAINT "salary_credits_credited_ck" CHECK (
    "state" NOT IN ('received', 'reversed') OR ("credit_move_id" IS NOT NULL AND "received_at" IS NOT NULL)
  ),
  CONSTRAINT "salary_credits_reversed_ck" CHECK (
    ("state" = 'reversed') = ("reversal_move_id" IS NOT NULL AND "reversed_at" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "salary_credits_user_idx" ON "bank"."salary_credits" ("user_id", "created_at" DESC);

-- The split of one credit, fixed when the credit arrived: each leg's amount into one of the person's spaces.
CREATE TABLE IF NOT EXISTS "bank"."salary_split_legs" (
  "network_id" text NOT NULL REFERENCES "bank"."salary_credits" ("network_id"),
  "position" smallint NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  "amount" numeric(38, 18) NOT NULL,
  -- pending: not yet answered by the partner; settled: moved; rejected: the partner refused, nothing moved;
  -- unsplit: moved back to the main balance by a reversal.
  "status" text NOT NULL DEFAULT 'pending',
  "move_id" text,
  "rejection_code" text,
  "unsplit_move_id" text,
  PRIMARY KEY ("network_id", "position"),
  CONSTRAINT "salary_split_legs_position_ck" CHECK ("position" BETWEEN 0 AND 9),
  CONSTRAINT "salary_split_legs_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "salary_split_legs_status_ck" CHECK ("status" IN ('pending', 'settled', 'rejected', 'unsplit')),
  CONSTRAINT "salary_split_legs_moved_ck" CHECK ("status" NOT IN ('settled', 'unsplit') OR "move_id" IS NOT NULL),
  CONSTRAINT "salary_split_legs_rejected_ck" CHECK (("status" = 'rejected') = ("rejection_code" IS NOT NULL)),
  CONSTRAINT "salary_split_legs_unsplit_ck" CHECK (("status" = 'unsplit') = ("unsplit_move_id" IS NOT NULL))
);
