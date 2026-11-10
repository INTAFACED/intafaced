# Order types

The spot order types the API accepts: the same list the trading ticket shows, in its order. Each row says how to send it to POST /api/v1/orders.

The same list is served live at GET /api/v1/order-types.

## Accepted order types

| Order type  | Body type         | Fields that make it this type      | Time in force          | Note                                                                                                                                                                                                                                 |
| ----------- | ----------------- | ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Limit       | `limit`           | `price`                            | GTC, GTD, PO, IOC, FOK |                                                                                                                                                                                                                                      |
| Stop-limit  | `stop_limit`      | `price, stopPrice`                 | GTC                    |                                                                                                                                                                                                                                      |
| Stop-market | `stop`            | `stopPrice`                        | GTC                    |                                                                                                                                                                                                                                      |
| OCO         | `limit`           | `price, oco, takeProfit, stopLoss` | GTC                    |                                                                                                                                                                                                                                      |
| Bracket     | `market or limit` | `bracket, takeProfit, stopLoss`    | IOC, FOK, GTC          | A market entry, or a limit entry with IOC or FOK, resolves inside the request. A GTC limit entry rests only while the login that placed it lasts, is cancelled before that login runs out, and has no stop loss while partly filled. |
| OTO         | `limit`           | `price, oto, close`                | GTC, IOC, FOK          |                                                                                                                                                                                                                                      |
| Market      | `market`          | none                               | GTC, FOK               | Never rests. GTC here is the engine’s immediate rule; FOK fills whole or not at all.                                                                                                                                                 |

## Example bodies

### Limit

```json
{
  "symbol": "BTC/USDT",
  "side": "buy",
  "amount": "0.001",
  "clientOrderId": "TEST-example-limit",
  "type": "limit",
  "price": "100",
  "timeInForce": "GTC"
}
```

### Stop-limit

```json
{
  "symbol": "BTC/USDT",
  "side": "buy",
  "amount": "0.001",
  "clientOrderId": "TEST-example-stop_limit",
  "type": "stop_limit",
  "price": "101",
  "stopPrice": "100",
  "timeInForce": "GTC"
}
```

### Stop-market

```json
{
  "symbol": "BTC/USDT",
  "side": "buy",
  "amount": "0.001",
  "clientOrderId": "TEST-example-stop_market",
  "type": "stop",
  "stopPrice": "100",
  "timeInForce": "GTC"
}
```

### OCO

```json
{
  "symbol": "BTC/USDT",
  "side": "buy",
  "amount": "0.001",
  "clientOrderId": "TEST-example-oco",
  "type": "limit",
  "price": "120",
  "timeInForce": "GTC",
  "oco": true,
  "takeProfit": {
    "stopPrice": "90"
  },
  "stopLoss": {
    "stopPrice": "110",
    "price": "120"
  }
}
```

### Bracket

```json
{
  "symbol": "BTC/USDT",
  "side": "buy",
  "amount": "0.001",
  "clientOrderId": "TEST-example-bracket",
  "type": "market",
  "timeInForce": "GTC",
  "bracket": true,
  "takeProfit": {
    "stopPrice": "110"
  },
  "stopLoss": {
    "stopPrice": "90"
  }
}
```

### OTO

```json
{
  "symbol": "BTC/USDT",
  "side": "buy",
  "amount": "0.001",
  "clientOrderId": "TEST-example-oto",
  "type": "limit",
  "price": "100",
  "timeInForce": "GTC",
  "oto": true,
  "close": {
    "price": "110"
  }
}
```

### Market

```json
{
  "symbol": "BTC/USDT",
  "side": "buy",
  "amount": "0.001",
  "clientOrderId": "TEST-example-market",
  "type": "market",
  "timeInForce": "GTC"
}
```

## Listed but refused

The ticket lists these, disabled. The API refuses them with the code shown.

| Order type    | Refusal code                   |
| ------------- | ------------------------------ |
| Trailing stop | `trade.order_type_unsupported` |
