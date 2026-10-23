DROP TABLE IF EXISTS notify.maintenance_reminders;
DROP TABLE IF EXISTS notify.maintenance_moves;
ALTER TABLE notify.notices DROP COLUMN IF EXISTS reminder_offsets;
