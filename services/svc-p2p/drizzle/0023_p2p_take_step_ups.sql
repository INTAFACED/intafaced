-- P-trade-orders-07: a take is confirmed with a fresh passkey or authenticator code.
-- One row per same-person approval svc-p2p consumed: the take it confirmed (trade_id and the
-- payload hash of its terms), and the signed-in session it was proved in. That session may take again until expires_at (ten minutes
-- after the confirmation) without a new one. A retry of the same take, same terms and same approval
-- inside that window reads its row and asks identity nothing. No balance is stored here.
-- Reversal: 0023_p2p_take_step_ups.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."take_step_ups" (
  "approval_id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "trade_id" uuid NOT NULL,
  "payload_hash" text NOT NULL,
  "confirmed_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "take_step_ups_window_ck" CHECK ("expires_at" > "confirmed_at")
);
CREATE INDEX IF NOT EXISTS "take_step_ups_session_idx" ON "p2p"."take_step_ups" ("user_id", "session_id", "expires_at" DESC);
