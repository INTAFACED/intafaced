-- RC-p2p-02 (J-p2p-21): an order's escrow is the ledger's or a contract's, chosen at take and fixed after.
--
-- A contract-escrow order holds nothing in the ledger: the seller's tokens sit in the SovereignEscrow contract on the
-- configured chain, and both parties sign every call from their own wallets. This service stores only what it needs to
-- check the deal against the order: the terms the deal must carry (chain, token, base units, buyer wallet, dispute
-- window), fixed at take, and the deal id and seller wallet, written once when the seller attaches the opened deal.
-- No balance is stored here.
-- Reversal: 20261118060000_p2p_contract_escrow.down.sql
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "escrow_kind" text NOT NULL DEFAULT 'ledger';
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "contract_chain_id" integer;
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "contract_token" text;
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "contract_units" numeric(78, 0);
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "contract_buyer_wallet" text;
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "contract_dispute_window_seconds" integer;
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "contract_deal_id" numeric(78, 0);
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "contract_seller_wallet" text;

ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_escrow_kind_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_escrow_kind_ck" CHECK ("escrow_kind" IN ('ledger', 'contract'));

-- A ledger order carries no contract terms; a contract order carries all of them.
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_contract_terms_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_contract_terms_ck"
  CHECK (
    ("escrow_kind" = 'ledger'
      AND "contract_chain_id" IS NULL AND "contract_token" IS NULL AND "contract_units" IS NULL
      AND "contract_buyer_wallet" IS NULL AND "contract_dispute_window_seconds" IS NULL
      AND "contract_deal_id" IS NULL AND "contract_seller_wallet" IS NULL)
    OR ("escrow_kind" = 'contract'
      AND "contract_chain_id" > 0 AND "contract_token" ~ '^0x[0-9a-fA-F]{40}$' AND "contract_units" > 0
      AND "contract_buyer_wallet" ~ '^0x[0-9a-fA-F]{40}$' AND "contract_dispute_window_seconds" > 0
      AND ("contract_deal_id" IS NULL) = ("contract_seller_wallet" IS NULL))
  );

-- Never both: a contract order never records a ledger lock attempt, and the attempt is claimed before any ledger post.
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_contract_no_ledger_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_contract_no_ledger_ck"
  CHECK ("escrow_kind" = 'ledger' OR "escrow_lock_attempts" IS NULL OR "escrow_lock_attempts" = 0);

-- A contract order past `created` is held by a deal it names, unless it was voided before any deal.
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_contract_deal_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_contract_deal_ck"
  CHECK (
    "escrow_kind" = 'ledger' OR "status" = 'created' OR "contract_deal_id" IS NOT NULL
    OR "resolution" IS NOT DISTINCT FROM 'voided'
  );

-- One deal backs one order.
CREATE UNIQUE INDEX IF NOT EXISTS "p2p_trades_contract_deal_uq"
  ON "p2p"."p2p_trades" ("contract_chain_id", "contract_deal_id") WHERE "contract_deal_id" IS NOT NULL;

-- The kind and the deal's terms are fixed at take; the deal id and seller wallet are written once.
CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_contract_escrow_fixed"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."escrow_kind", NEW."contract_chain_id", NEW."contract_token", NEW."contract_units",
         NEW."contract_buyer_wallet", NEW."contract_dispute_window_seconds")
     IS DISTINCT FROM
     ROW(OLD."escrow_kind", OLD."contract_chain_id", OLD."contract_token", OLD."contract_units",
         OLD."contract_buyer_wallet", OLD."contract_dispute_window_seconds") THEN
    RAISE EXCEPTION 'p2p.escrow_kind_immutable: an order''s escrow kind and contract terms are fixed at take — trade %', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."contract_deal_id" IS NOT NULL
     AND ROW(NEW."contract_deal_id", NEW."contract_seller_wallet") IS DISTINCT FROM ROW(OLD."contract_deal_id", OLD."contract_seller_wallet") THEN
    RAISE EXCEPTION 'p2p.escrow_kind_immutable: an order''s contract deal is written once — trade %', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "p2p_trades_contract_escrow_fixed_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_contract_escrow_fixed_trg" BEFORE UPDATE ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_contract_escrow_fixed"();

-- A contract order the seller never funded is voided by the sweep with no lock attempt (0014 required exactly one).
CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_lock_attempts_monotonic"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."escrow_lock_attempts" := 0;
    RETURN NEW;
  END IF;
  IF NEW."escrow_lock_attempts" IS DISTINCT FROM OLD."escrow_lock_attempts" THEN
    IF OLD."escrow_lock_attempts" IS NULL OR NEW."escrow_lock_attempts" IS NULL
       OR NEW."escrow_lock_attempts" <> OLD."escrow_lock_attempts" + 1
       OR OLD."status" <> 'created' OR NEW."status" <> 'created' THEN
      RAISE EXCEPTION 'p2p: escrow lock attempt history cannot reset, decrease, jump or fabricate unknown history'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD."resolution" IS NULL AND NEW."resolution" = 'voided'
     AND OLD."escrow_lock_attempts" IS DISTINCT FROM 1::bigint
     -- RC-p2p-02: a contract order never attempts a ledger lock (p2p_trades_contract_no_ledger_ck), so its void of an
     -- unfunded order needs none; it holds nothing in the ledger to strand.
     AND NOT (OLD."escrow_kind" = 'contract' AND OLD."escrow_lock_attempts" = 0::bigint) THEN
    RAISE EXCEPTION 'p2p: unresolved escrow lock attempts cannot be voided'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
