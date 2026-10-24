-- P-trade-orders-07 and -16: a release is confirmed with a fresh passkey or authenticator code.
-- One row per same-person approval svc-p2p consumed for a release: the order it confirmed (trade_id and the payload
-- hash identity minted it over), and the signed-in session it was proved in. That session may release again until
-- expires_at (ten minutes after the confirmation) without a new one. A retry of the same release with the same approval
-- inside that window reads its row and asks identity nothing. Kept apart from take_step_ups: a take's confirmation
-- never covers a release. No balance is stored here.
-- Reversal: 20261024111016_p2p_release_step_ups.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."release_step_ups" (
  "approval_id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "trade_id" uuid NOT NULL,
  "payload_hash" text NOT NULL,
  "confirmed_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "release_step_ups_window_ck" CHECK ("expires_at" > "confirmed_at")
);
CREATE INDEX IF NOT EXISTS "release_step_ups_session_idx" ON "p2p"."release_step_ups" ("user_id", "session_id", "expires_at" DESC);
