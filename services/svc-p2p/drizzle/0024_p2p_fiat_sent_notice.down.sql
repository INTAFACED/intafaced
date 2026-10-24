-- Reverses 0024_p2p_fiat_sent_notice.sql.
DROP INDEX IF EXISTS "p2p"."p2p_trades_fiat_sent_notice_owed_idx";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "fiat_sent_notice_at";
