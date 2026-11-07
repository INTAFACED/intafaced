-- P-ads-merchant-06 part 2 (J-p2p-05 #1): drafts and ads waiting for review. No balance is stored here.
--
-- `draft`: saved by its maker, not on the board, not takeable. `pending`: submitted for listing while the owner's
-- review switch (P2P_AD_REVIEW) is `required`; it waits for review, off the board and not takeable. The board, takes and
-- every listing read only `active`, so neither state can be traded. `status_since` is kept by the existing trigger.
-- Reversal: 20261106140000_p2p_ad_drafts_review.down.sql
ALTER TYPE "p2p"."offer_status" ADD VALUE IF NOT EXISTS 'draft';
ALTER TYPE "p2p"."offer_status" ADD VALUE IF NOT EXISTS 'pending';
-- Whether the ad was ever on the board. Every ad before this migration was listed when posted; a draft is not until it
-- is listed (`active`), so closing a draft or an ad waiting for review and relisting it cannot skip review.
ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "listed" boolean NOT NULL DEFAULT true;
