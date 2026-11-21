-- Reverses 20261120132941_api_version_defaults.sql. Every account default is dropped; key calls then need the header.
DROP TABLE IF EXISTS "identity"."api_version_defaults";
