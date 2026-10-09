-- svc-pay · a parent cycle longer than one node has to fail in the database.
-- Reversal: 0027_pay_merchant_parent_no_cycle.down.sql
--
-- 0009's merchants_parent_not_self rejects only a merchant whose
-- parent_merchant_id equals its own id. The comment there says the ancestor
-- walk is bounded, so a cycle of length two or more, such as A parent of B
-- and B parent of A, is still a valid update. 0009 is already applied.
-- This file does not edit it. merchants_parent_not_self stays.
--
-- Postgres CHECK cannot subquery, so a BEFORE INSERT OR UPDATE OF
-- parent_merchant_id trigger is the close. The walk starts at the new
-- parent. It refuses when it reaches the row being written, which is a
-- cycle of any length, including two. It also refuses when the walk repeats
-- any id, or passes a finite cap without a null parent, so a corrupted
-- chain cannot spin.
--
-- MAX_SUBMERCHANT_DEPTH in services/svc-pay/src/submerchants.ts is 4. That
-- constant is a comment reference for the service walk, not the rule in
-- this trigger. parent_walk_cap is 32, a spin guard. A 2-cycle fails by
-- identity on the second step, which is inside both numbers, so the cycle
-- is still refused while that depth constant stays 4.
--
-- No merchant row is written. This migration moves no value.

CREATE OR REPLACE FUNCTION "pay"."merchants_parent_no_cycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  walked uuid;
  next_id uuid;
  seen uuid[] := ARRAY[]::uuid[];
  steps integer := 0;
  -- Spin guard. Not MAX_SUBMERCHANT_DEPTH (4). A 2-cycle fails by identity.
  parent_walk_cap constant integer := 32;
BEGIN
  IF NEW.parent_merchant_id IS NULL THEN
    RETURN NEW;
  END IF;

  walked := NEW.parent_merchant_id;

  WHILE walked IS NOT NULL LOOP
    IF walked = NEW.id THEN
      RAISE EXCEPTION 'merchants_parent_no_cycle: walk reached this merchant'
        USING ERRCODE = '23514';
    END IF;

    IF walked = ANY (seen) THEN
      RAISE EXCEPTION 'merchants_parent_no_cycle: walk repeated an id'
        USING ERRCODE = '23514';
    END IF;

    seen := array_append(seen, walked);
    steps := steps + 1;

    IF steps > parent_walk_cap THEN
      RAISE EXCEPTION 'merchants_parent_no_cycle: walk passed the cap without a null parent'
        USING ERRCODE = '23514';
    END IF;

    SELECT m.parent_merchant_id
      INTO next_id
      FROM "pay"."merchants" AS m
     WHERE m.id = walked;

    walked := next_id;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "merchants_parent_no_cycle_trg" ON "pay"."merchants";
CREATE TRIGGER "merchants_parent_no_cycle_trg"
  BEFORE INSERT OR UPDATE OF "parent_merchant_id" ON "pay"."merchants"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchants_parent_no_cycle"();
