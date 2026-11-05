-- Reverses the per-surface share hits table (RC-campaigns-06). The visit counts go with it; tokens and attribution stay.
DROP TABLE IF EXISTS "identity"."affiliate_share_hits";
