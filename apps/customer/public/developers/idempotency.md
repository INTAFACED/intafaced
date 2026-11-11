# Idempotency

Send an Idempotency-Key header with an order, and the venue places it at most once, however many times you retry.

## One order per key

1. Prepare the order with POST /api/v1/venue/prepare and the header Idempotency-Key: your key, 1 to 255 visible characters with no spaces. Leave clientOrderKey out: your key is sent to the venue as the order’s client order id.
2. Sign the prepared payload with your wallet or agent key, then send it with POST /api/v1/venue/submit and the same header.
3. A retry with the same key and body answers the stored response, with the header idempotent-replayed: true. The venue has one order.
4. The same key with a changed order (another quantity, price or side) answers 409 with the code idempotency.conflict.
5. A request sent while another with the same key is still being sent answers 409 with the code idempotency.in_progress and a retry-after header. Wait and retry with the same key.

## Accepted is not final

A timeout or a 5xx after the order was sent does not mean it failed. Read the order by key with GET /api/v1/venue/orders/by-key?idempotencyKey= and your key. It reads unknown until the venue answers, never failed or filled. Then it reads accepted, with the venue’s own record of the order.

A retry on the same key sends the same signed order again, so the venue never creates a second order. Never send the same order under a new key.

## Listing orders

GET /api/v1/venue/orders?owner= your wallet address lists your orders oldest first, each once. Pass limit for the page size and the nextCursor of one page as cursor for the next. On the last page nextCursor is empty.

The largest page is the owner’s setting. While it is not set, every list call refuses with the code trade.venue_orders_page_max_unset. A limit above it refuses with trade.venue_orders_limit_invalid.
