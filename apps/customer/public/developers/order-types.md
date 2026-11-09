# Order types

The spot order types the API accepts: the same list the trading ticket shows, in its order. Each row says how to send it to POST /api/v1/orders.

The same list is served live at GET /api/v1/order-types.

## Accepted order types

| Order type  | Body type    | Fields that make it this type | Time in force                   |
| ----------- | ------------ | ----------------------------- | ------------------------------- |
| Limit       | `limit`      | `price`                       | GTC, GTD, PO, IOC, FOK          |
| Stop-limit  | `stop_limit` | `price, stopPrice`            | GTC                             |
| Stop-market | `stop`       | `stopPrice`                   | GTC                             |
| OCO         | `limit`      | `takeProfit, stopLoss`        | GTC                             |
| Bracket     | `limit       | market`                       | `bracket, takeProfit, stopLoss` | IOC, FOK, GTC |
| OTO         | `limit`      | `oto, close`                  | GTC, IOC, FOK                   |
| Market      | `market`     | none                          | GTC, FOK                        |

## Listed but refused

The ticket lists these, disabled. The API refuses them with the code shown.

| Order type    | Refusal code                   |
| ------------- | ------------------------------ |
| Trailing stop | `trade.order_type_unsupported` |
