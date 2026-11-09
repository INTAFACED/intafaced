-- intafaced:destructive — reversal of 20261107083000_incidents.sql
--
-- Lossy by nature: every incident, its participants, tasks and timeline are dropped. With them gone every incident list and
-- metric is empty.
DROP TRIGGER IF EXISTS incident_timeline_append_only ON ops.incident_timeline;
DROP TABLE IF EXISTS ops.incident_timeline;
DROP TABLE IF EXISTS ops.incident_tasks;
DROP TABLE IF EXISTS ops.incident_participants;
DROP TABLE IF EXISTS ops.incidents;
