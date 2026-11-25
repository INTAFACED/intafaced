-- USER WITHDRAW DESTINATION — a real ref before withdrawHold.
--
-- Off-ramp already posts ledger-client withdrawHold/withdrawSettle. Without a
-- persisted row the dest is invented per withdraw and a crash leaves nothing a
-- later attempt can honestly reuse. This table is that row.
--
-- WHAT THIS DOES NOT DO: invent a PSP, live-wire a bank rail, or move value.
-- Value still leaves through offramp → withdrawHold after this ref is loaded.

CREATE TABLE IF NOT EXISTS "bank"."user_withdraw_destinations" (
  "user_id"    text NOT NULL,
  "kind"       text NOT NULL CONSTRAINT "user_withdraw_destinations_kind_not_blank" CHECK (length(btrim("kind")) > 0),
  "ref"        text NOT NULL CONSTRAINT "user_withdraw_destinations_ref_not_blank" CHECK (length(btrim("ref")) > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "kind")
);

CREATE INDEX IF NOT EXISTS "user_withdraw_destinations_user_idx"
  ON "bank"."user_withdraw_destinations" ("user_id");
