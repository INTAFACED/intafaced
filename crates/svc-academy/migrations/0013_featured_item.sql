-- svc-academy · the hub's featured slot (AC-articles-01)
-- Reversal: 0013_featured_item.down.sql
--
-- One row per slot, chosen by staff with a reason. No row means nothing is
-- featured, and the hub says so; nothing is ever auto-promoted into it.

CREATE TABLE IF NOT EXISTS "academy"."featured_items" (
  "slot"        text PRIMARY KEY,
  "item_slug"   text NOT NULL,
  "reason"      text NOT NULL,
  "chosen_by"   uuid NOT NULL,
  "chosen_at"   timestamptz NOT NULL,
  CONSTRAINT "featured_items_slot_chk" CHECK ("slot" = 'hub'),
  CONSTRAINT "featured_items_reason_chk" CHECK (char_length(btrim("reason")) > 0)
);
