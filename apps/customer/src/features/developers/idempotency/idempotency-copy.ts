import { defineCopy } from '../../../shared/i18n';

// /developers/idempotency (J-developer-05; DV-auth-03): how an order sent over the API with an Idempotency-Key is placed
// on the venue at most once, what an answer that is not final means, and how to page the list of orders. The codes and
// paths are svc-trade's (src/venue/user-venue-rest.ts).
export const idempotencyCopy = defineCopy('developers-idempotency', {
  lead: 'Send an Idempotency-Key header with an order, and the venue places it at most once, however many times you retry.',
  rulesTitle: 'One order per key',
  rulePrepare:
    'Prepare the order with POST /api/v1/venue/prepare and the header Idempotency-Key: your key, 1 to 255 visible characters with no spaces. Leave clientOrderKey out: your key is sent to the venue as the order’s client order id.',
  ruleSubmit: 'Sign the prepared payload with your wallet or agent key, then send it with POST /api/v1/venue/submit and the same header.',
  ruleReplay:
    'A retry with the same key and body answers the stored response, with the header idempotent-replayed: true. The venue has one order.',
  ruleConflict: 'The same key with a changed order (another quantity, price or side) answers 409 with the code idempotency.conflict.',
  ruleInProgress:
    'A request sent while another with the same key is still being sent answers 409 with the code idempotency.in_progress and a retry-after header. Wait and retry with the same key.',
  finalTitle: 'Accepted is not final',
  finalBody:
    'A timeout or a 5xx after the order was sent does not mean it failed. Read the order by key with GET /api/v1/venue/orders/by-key?idempotencyKey= and your key. It reads unknown until the venue answers, never failed or filled. Then it reads accepted, with the venue’s own record of the order.',
  finalRetry:
    'A retry on the same key sends the same signed order again, so the venue never creates a second order. Never send the same order under a new key.',
  listTitle: 'Listing orders',
  listBody:
    'GET /api/v1/venue/orders?owner= your wallet address lists your orders oldest first, each once. Pass limit for the page size and the nextCursor of one page as cursor for the next. On the last page nextCursor is empty.',
  listMax:
    'The largest page is the owner’s setting. While it is not set, every list call refuses with the code trade.venue_orders_page_max_unset. A limit above it refuses with trade.venue_orders_limit_invalid.',
  back: 'Developer home',
});
