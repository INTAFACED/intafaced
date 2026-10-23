-- intafaced:destructive — reversal of 0108_futures_reverse_requests.sql drops the record of every reverse. The orders
-- each one placed stay in trade.futures_orders under their `rv:c:` and `rv:o:` client ids; a reverse still working is not finished
-- by anything after this, and its trader sees the close (and any open) in their orders.
DROP TABLE IF EXISTS "trade"."futures_reverse_requests";
