-- Reverse 0064_copy_leader_listings.sql
-- Events in 0065 use copy_leader_append_only, so reverse 0065 first.
DROP TRIGGER IF EXISTS copy_leader_ops_requests_append_only ON trade.copy_leader_ops_requests;
DROP TABLE IF EXISTS trade.copy_leader_ops_requests;
DROP TRIGGER IF EXISTS copy_leader_listing_audit_append_only ON trade.copy_leader_listing_audit;
DROP TABLE IF EXISTS trade.copy_leader_listing_audit;
DROP TABLE IF EXISTS trade.copy_leader_listings;
DROP FUNCTION IF EXISTS trade.copy_leader_append_only();
