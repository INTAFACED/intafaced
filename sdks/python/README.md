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

## Strategy API (intafaced_quant)

Private client for the strategy API. Not published. A blank base URL or API key refuses. There is no default host. The key goes as `Authorization: Bearer <key>`; give it only the scopes it needs (`quant:read`, `quant:run`, `trade:read`, `trade:write`).

```python
import os

from intafaced_quant import QuantApiError, QuantClient, strategy_template

quant = QuantClient(
    base_url=os.environ.get("QUANT_API_BASE_URL", ""),
    api_key=os.environ.get("QUANT_API_KEY", ""),
)

projects = quant.list_strategies(limit=20)          # quant:read
project = quant.get_strategy(strategy_id)
runs = quant.backtest_history(limit=20)
result = quant.backtest_result(run_id)
report = quant.backtest_report(run_id)

# quant:run. The Idempotency-Key is your own business key; the client never makes one up.
started = quant.start_backtest(backtest_input, idempotency_key=f"backtest:{strategy_id}:v{version}:{day}")

live = quant.list_live_runs()                         # trade:read
quant.stop_live_run(live_run_id, seq)                 # trade:write; open orders cancelled, position kept
quant.liquidate_live_run(live_run_id, seq)            # trade:write; stop, then a reduce-only close

try:
    quant.start_backtest(backtest_input, idempotency_key="backtest:reused")
except QuantApiError as refusal:
    refusal.status, refusal.code  # e.g. 409, "quant.idempotency_key_reused"
```

Decimals stay strings: a float in a request is refused, and a fractional number in an answer comes back as a string.

`strategy_template()` returns a minimal Python strategy that the sandbox runs. The sandbox takes a small Python subset (assignments, a one-line `if ...:` body, `print`, and the `market`, `oms` and `book` objects) with the same events and limits as the JavaScript runtime. It has no imports, functions or loops.
