-- intafaced:destructive — reversal of 20261024160000_staff_holds.sql
--
-- Lossy by nature: svc-ops' record of every staff hold and its ledger posts is dropped. The held value itself stays in
-- the ledger's `ops:hold:<holdNo>` pots, so run this only where no hold was ever placed.
DROP TRIGGER IF EXISTS staff_hold_movements_guard ON ops.staff_hold_movements;
DROP FUNCTION IF EXISTS ops.staff_hold_movements_guard();
DROP TABLE IF EXISTS ops.staff_hold_movements;
DROP TABLE IF EXISTS ops.staff_holds;
