-- svc-academy · buying a paid course's certificate track from the buyer's own wallet (J-academy-07: AC-commerce-01,
-- AC-access-grants-01). Reversal: 20261112092541_course_purchases.down.sql
--
-- `course_purchases`: one row per purchase intent of one learner on one course staff made, keyed
-- `academy:purchase:<course>:<learner>:<n>` (the ledger post's key too). The row and its terms (price, asset, the payment
-- token, INTAFACED's receiving address, the buyer's wallet and the block the intent was made at) are stored before the
-- wallet is asked to sign anything, so a second press or a lost reply finds the same intent and the wallet is never asked
-- twice. INTAFACED holds none of the buyer's money: the buyer's wallet pays INTAFACED's own receiving address, and only
-- once the chain confirms that payment does the ledger record it (the launch money model). A refund is INTAFACED's own
-- send back to the buying wallet under `academy:refund:<course>:<learner>:<n>`, stored before it is sent.
--
-- States: `awaiting_signature` (intent stored, the wallet asked), `abandoned` (the wallet refused; a new Buy reopens the
-- same row), `submitted` (a chain transaction is known), `confirmed` (the chain shows the payment at the confirmations
-- the owner set; the ledger post is next), `posted` (the ledger recorded it and the grant exists), `failed` (the
-- transaction reverted or paid something else; nothing was recorded), `refunding` (a refund intent is stored),
-- `refunded` (the refund confirmed, the reverse posted and the grant revoked).

CREATE TABLE IF NOT EXISTS "academy"."course_purchases" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"           uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "course_slug"         text NOT NULL,
  "user_id"             uuid NOT NULL,
  "n"                   integer NOT NULL,
  "purchase_key"        text NOT NULL,
  "price"               numeric(38, 18) NOT NULL,
  "asset"               text NOT NULL,
  "chain_id"            integer NOT NULL,
  "token"               text NOT NULL,
  "token_decimals"      integer NOT NULL,
  "receiver"            text NOT NULL,
  "payer"               text NOT NULL,
  "from_block"          bigint NOT NULL,
  "state"               text NOT NULL,
  "tx_hash"             text,
  "failure"             text,
  "post_state"          text,
  "post_reason"         text,
  "ledger_tx_id"        text,
  "refund_key"          text,
  "refund_reason"       text,
  "refund_actor"        uuid,
  "refund_tx_hash"      text,
  "refund_send_at"      timestamptz,
  "refund_ledger_tx_id" text,
  "created_at"          timestamptz NOT NULL,
  "updated_at"          timestamptz NOT NULL,
  "posted_at"           timestamptz,
  "refunded_at"         timestamptz,
  CONSTRAINT "course_purchases_key_uq" UNIQUE ("purchase_key"),
  CONSTRAINT "course_purchases_n_uq" UNIQUE ("course_id", "user_id", "n"),
  CONSTRAINT "course_purchases_tx_uq" UNIQUE ("chain_id", "tx_hash"),
  CONSTRAINT "course_purchases_refund_key_uq" UNIQUE ("refund_key"),
  CONSTRAINT "course_purchases_refund_tx_uq" UNIQUE ("chain_id", "refund_tx_hash"),
  CONSTRAINT "course_purchases_n_chk" CHECK ("n" > 0),
  CONSTRAINT "course_purchases_price_chk" CHECK ("price" > 0),
  CONSTRAINT "course_purchases_state_chk" CHECK (
    "state" IN ('awaiting_signature', 'abandoned', 'submitted', 'confirmed', 'posted', 'failed', 'refunding', 'refunded')
  ),
  CONSTRAINT "course_purchases_post_state_chk" CHECK ("post_state" IS NULL OR "post_state" IN ('posting', 'unknown', 'refused')),
  CONSTRAINT "course_purchases_hash_chk" CHECK (
    "state" IN ('awaiting_signature', 'abandoned') OR "tx_hash" IS NOT NULL
  ),
  CONSTRAINT "course_purchases_posted_chk" CHECK ("state" NOT IN ('posted', 'refunding', 'refunded') OR "ledger_tx_id" IS NOT NULL),
  CONSTRAINT "course_purchases_refund_chk" CHECK (
    "state" NOT IN ('refunding', 'refunded')
    OR ("refund_key" IS NOT NULL AND "refund_actor" IS NOT NULL AND char_length(btrim(coalesce("refund_reason", ''))) > 0)
  ),
  CONSTRAINT "course_purchases_refunded_chk" CHECK ("state" <> 'refunded' OR "refund_ledger_tx_id" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "course_purchases_user_idx" ON "academy"."course_purchases" ("user_id", "course_id", "n" DESC);
CREATE INDEX IF NOT EXISTS "course_purchases_open_idx" ON "academy"."course_purchases" ("state")
  WHERE "state" IN ('awaiting_signature', 'submitted', 'confirmed', 'refunding');

-- A bought certificate track can now be enrolled on (J-academy-07 #4): the enrolment's track allows it.
ALTER TABLE "academy"."course_enrolments" DROP CONSTRAINT IF EXISTS "course_enrolments_track_chk";
ALTER TABLE "academy"."course_enrolments" ADD CONSTRAINT "course_enrolments_track_chk" CHECK ("track" IN ('audit', 'certificate'));
