-- Customer depth for the screens already built: offer edits that do not
-- rewrite an open order, a client-chosen create key, order chat, follow/block,
-- and the party's own dispute list. No balance is stored here.

ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "terms_snapshot" text;

-- Same freeze as 0010, plus the terms text copied at take. A later offer edit
-- must not be able to change what the taker accepted.
CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_original_terms_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'p2p: immutable original terms cannot be deleted — trade %', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."original_terms_claimed_at" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."offer_id", NEW."maker_id", NEW."taker_id", NEW."seller_id", NEW."buyer_id",
         NEW."asset", NEW."fiat_currency", NEW."amount", NEW."price", NEW."fiat_amount", NEW."method", NEW."fee_bps",
         NEW."original_terms_claimed_at", NEW."terms_snapshot")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."offer_id", OLD."maker_id", OLD."taker_id", OLD."seller_id", OLD."buyer_id",
         OLD."asset", OLD."fiat_currency", OLD."amount", OLD."price", OLD."fiat_amount", OLD."method", OLD."fee_bps",
         OLD."original_terms_claimed_at", OLD."terms_snapshot") THEN
    RAISE EXCEPTION 'p2p: immutable original terms cannot change or be claimed after insert — trade %', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."escrowed_at" IS NOT NULL AND NEW."escrowed_at" IS DISTINCT FROM OLD."escrowed_at" THEN
    RAISE EXCEPTION 'p2p: escrow stamp cannot change or be cleared — trade %', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."resolution" IS NOT NULL AND ROW(NEW."status", NEW."resolution", NEW."resolution_reason", NEW."resolved_at")
     IS DISTINCT FROM ROW(OLD."status", OLD."resolution", OLD."resolution_reason", OLD."resolved_at") THEN
    RAISE EXCEPTION 'p2p: terminal decision and original recipe reason cannot change — trade %', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."settled_at" IS NOT NULL AND NEW."settled_at" IS DISTINCT FROM OLD."settled_at" THEN
    RAISE EXCEPTION 'p2p: settlement stamp cannot change or be cleared — trade %', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE IF NOT EXISTS "p2p"."write_keys" (
  "actor_id" text NOT NULL,
  "scope" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "subject_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("actor_id", "scope", "idempotency_key")
);

CREATE TABLE IF NOT EXISTS "p2p"."chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trade_id" uuid NOT NULL REFERENCES "p2p"."p2p_trades"("id"),
  "sender_id" text NOT NULL,
  "client_id" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_messages_body_ck" CHECK (char_length("body") BETWEEN 1 AND 2000),
  CONSTRAINT "chat_messages_client_ck" CHECK (char_length("client_id") BETWEEN 1 AND 128),
  CONSTRAINT "chat_messages_client_uq" UNIQUE ("trade_id", "sender_id", "client_id")
);

CREATE INDEX IF NOT EXISTS "chat_messages_trade_idx" ON "p2p"."chat_messages" ("trade_id", "created_at", "id");

CREATE TABLE IF NOT EXISTS "p2p"."chat_reads" (
  "trade_id" uuid NOT NULL REFERENCES "p2p"."p2p_trades"("id"),
  "user_id" text NOT NULL,
  "read_at" timestamptz NOT NULL,
  PRIMARY KEY ("trade_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "p2p"."contacts" (
  "owner_id" text NOT NULL,
  "peer_id" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "peer_id", "kind"),
  CONSTRAINT "contacts_kind_ck" CHECK ("kind" IN ('follow', 'block')),
  CONSTRAINT "contacts_not_self_ck" CHECK ("owner_id" <> "peer_id")
);

CREATE INDEX IF NOT EXISTS "contacts_peer_block_idx" ON "p2p"."contacts" ("peer_id", "kind");
