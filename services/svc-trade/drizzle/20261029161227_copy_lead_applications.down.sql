-- intafaced:destructive — reversal of 20261029161227_copy_lead_applications.sql
DROP TRIGGER IF EXISTS copy_lead_criteria_append_only ON trade.copy_lead_criteria;
DROP TABLE IF EXISTS trade.copy_lead_criteria;
DROP TRIGGER IF EXISTS copy_lead_applications_forward_trg ON trade.copy_lead_applications;
DROP FUNCTION IF EXISTS trade.copy_lead_applications_forward();
DROP TABLE IF EXISTS trade.copy_lead_applications;
