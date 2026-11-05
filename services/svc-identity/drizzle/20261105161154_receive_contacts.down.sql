-- Reverses 20261105161154_receive_contacts.sql. Payments already received stay where they landed; only the extra
-- addresses people could pay by, and their audit, go.
DROP TABLE IF EXISTS "identity"."receive_contact_audit";
DROP TABLE IF EXISTS "identity"."receive_contacts";
