# Payments TypeScript SDK

Private merchant client. Not published. A blank base URL or API key refuses. There is no default host.

## List payments

`getPayments` returns `{ items, nextCursor }`. `nextCursor` is `null` on the last page. Pass it back as `query.cursor`. Query values are strings. A JSON array is refused.

```ts
import { createPayClient } from '@intafaced/sdk-ts';

const pay = createPayClient({
  baseUrl: process.env.PAY_API_BASE_URL ?? '',
  apiKey: process.env.PAY_API_KEY ?? '',
});

const page = await pay.getPayments({
  query: { merchantId, limit: '50', cursor, search, assetId, from, to },
});

for (const payment of page.items) {
  payment.amount; // decimal string
  payment.pricingSnapshot; // null when no fee was stored
  payment.failure; // null when the payment did not fail
}

const next = page.nextCursor;
```

Amounts stay decimal strings. A JSON number is refused on the way in and on the way out.
