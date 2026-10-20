-- Reverse 0017_ticket_properties.sql
-- Lossy by nature: priorities, types, labels and their log are dropped.

DROP TABLE IF EXISTS "support"."ticket_property_log";
DROP TABLE IF EXISTS "support"."ticket_properties";
