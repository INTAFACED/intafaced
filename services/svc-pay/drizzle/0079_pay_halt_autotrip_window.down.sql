-- intafaced:destructive — drops the auto-trip window and the counted-outcome
-- keys. User and rail halt rows cannot satisfy the previous target check, so
-- they are removed before that check is restored. Merchant and global halt
-- rows stay.
DROP TABLE IF EXISTS pay.halt_autotrip_counted;

DROP TRIGGER IF EXISTS pay_halt_autotrip_window_no_delete ON pay.halt_autotrip_window;
DROP TABLE IF EXISTS pay.halt_autotrip_window;

-- halt_events accepts an insert (its immutability trigger is update and delete
-- only). source stays auto_trip: operator requires an actor, and a migration
-- has none. The reason is the record that this downgrade cleared the row.
INSERT INTO pay.halt_events (scope, target, halted, reason, source, actor_user_id, confirmed_by_user_id, request_id, version)
SELECT scope, target, false, 'cleared by migration', 'auto_trip', NULL, NULL, NULL, version + 1
  FROM pay.halts
 WHERE target LIKE 'user:%' OR target LIKE 'rail:%';

ALTER TABLE pay.halts DISABLE TRIGGER pay_halts_no_delete;
DELETE FROM pay.halts WHERE target LIKE 'user:%' OR target LIKE 'rail:%';
ALTER TABLE pay.halts ENABLE TRIGGER pay_halts_no_delete;

ALTER TABLE pay.halts DROP CONSTRAINT IF EXISTS pay_halts_target_kind_check;
ALTER TABLE pay.halts ADD CONSTRAINT pay_halts_target_check CHECK (
  target = 'global'
  OR target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);
