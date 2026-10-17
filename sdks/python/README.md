# Payments Python SDK

Private merchant client. Not published. A blank base URL or API key refuses. There is no default host.

## List payments

`get_payments` returns `{ items, nextCursor }`. `nextCursor` is `None` on the last page. Pass it back as `query["cursor"]`. Query values are strings. A JSON array is refused.

```python
import os

from intafaced_pay import create_pay_client

_client, pay = create_pay_client(
    base_url=os.environ.get("PAY_API_BASE_URL", ""),
    api_key=os.environ.get("PAY_API_KEY", ""),
)

page = pay.get_payments(
    query={
        "merchantId": merchant_id,
        "limit": "50",
        "cursor": cursor,
        "search": search,
        "assetId": asset_id,
        "from": start,
        "to": end,
    }
)

for payment in page["items"]:
    payment["amount"]  # decimal string
    payment["pricingSnapshot"]  # None when no fee was stored
    payment["failure"]  # None when the payment did not fail

next_cursor = page["nextCursor"]
```

Amounts stay decimal strings. A JSON number is refused on the way in and on the way out.
