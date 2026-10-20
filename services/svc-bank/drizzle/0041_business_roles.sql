-- Business team roles beyond maker/checker (W-security-accounts-04).
--
-- signer, editor, viewer, security_auditor and non_signing_admin join admin, maker and
-- checker. What each role may do is one table in src/business/business-policy.ts; no row
-- changes here, so every existing member keeps the role they have.
--
-- PG cannot use a newly added label until the statement commits, and nothing in this file
-- uses one.
--
-- Reversal: 0041_business_roles.down.sql

ALTER TYPE "bank"."business_member_role" ADD VALUE IF NOT EXISTS 'signer';
ALTER TYPE "bank"."business_member_role" ADD VALUE IF NOT EXISTS 'editor';
ALTER TYPE "bank"."business_member_role" ADD VALUE IF NOT EXISTS 'viewer';
ALTER TYPE "bank"."business_member_role" ADD VALUE IF NOT EXISTS 'security_auditor';
ALTER TYPE "bank"."business_member_role" ADD VALUE IF NOT EXISTS 'non_signing_admin';
