-- P-ads-merchant-18 (J-p2p-04 #3): adding, changing or removing a payment method is confirmed with a fresh passkey or
-- authenticator code, every time. One row per same-person approval svc-p2p consumed for a change: the method
-- (instrument_id), the kind of change, the payload hash identity minted it over (which names the details' digest) and
-- the signed-in session it was proved in. Until expires_at (ten minutes) the same session may resend that very change
-- with that approval after a lost answer; nothing else reuses it. Kept apart from take and release confirmations:
-- neither covers a payment-method change, nor this one an order.
-- No balance is stored here.
-- Reversal: 20261024233000_p2p_instrument_step_ups.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."instrument_step_ups" (
  "approval_id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "instrument_id" uuid NOT NULL,
  "change" text NOT NULL,
  "payload_hash" text NOT NULL,
  "confirmed_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "instrument_step_ups_change_ck" CHECK ("change" IN ('create', 'update', 'remove')),
  CONSTRAINT "instrument_step_ups_retry_ck" CHECK ("expires_at" > "confirmed_at")
);
