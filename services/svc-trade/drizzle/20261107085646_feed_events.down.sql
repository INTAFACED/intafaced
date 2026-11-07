-- intafaced:destructive drops the feed event journal added by the up migration; it holds no money and no customer record.
DROP TABLE IF EXISTS trade.feed_events;
