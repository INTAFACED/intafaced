-- trade.oco_leg_end · what the engine said when an OCO leg left the book unfilled
-- Reversal: 0071_oco_leg_end.down.sql
--
-- A sell OCO is one order with one hold and two engine legs. The parent may be closed (the unfilled hold
-- released) only once every base unit the engine executed on the legs has settled here. A leg that leaves the
-- book is either FULLY filled (no cancellation) or cancelled with `remaining_qty` unexecuted, so the engine's
-- cancellation is the only evidence of how much a leg executed. It is stored when it arrives, because the leg
-- cancellations of one OCO can arrive in different submissions.

CREATE TABLE IF NOT EXISTS "trade"."oco_leg_end" (
  "parent_id"      uuid NOT NULL,
  "leg"            text NOT NULL,
  "remaining_qty"  numeric(38, 18) NOT NULL,
  "reason"         text,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("parent_id", "leg"),
  CONSTRAINT "oco_leg_end_leg_ck" CHECK ("leg" IN ('tp', 'sl')),
  CONSTRAINT "oco_leg_end_remaining_ck" CHECK ("remaining_qty" >= 0)
);
