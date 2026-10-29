# API reference

Every trading REST route and WebSocket stream, under its product, with the permission a key needs. A route marked public also answers without a key.

## General

| Route                      | Name                | Permission                    |
| -------------------------- | ------------------- | ----------------------------- |
| `GET /api/v1/time`         | `fetchTime`         | public; with a key trade:read |
| `GET /api/v1/capabilities` | `fetchCapabilities` | public; with a key trade:read |

## Spot

| Route                                  | Name                    | Permission                    |
| -------------------------------------- | ----------------------- | ----------------------------- |
| `GET /api/v1/markets`                  | `fetchMarkets`          | public; with a key trade:read |
| `GET /api/v1/ticker/:symbol`           | `fetchTicker`           | public; with a key trade:read |
| `GET /api/v1/tickers`                  | `fetchTickers`          | public; with a key trade:read |
| `GET /api/v1/orderbook/:symbol`        | `fetchOrderBook`        | public; with a key trade:read |
| `GET /api/v1/ohlcv/:symbol`            | `fetchOHLCV`            | public; with a key trade:read |
| `GET /api/v1/trades/:symbol`           | `fetchTrades`           | public; with a key trade:read |
| `GET /api/v1/market-halt/:symbol`      | `fetchMarketHalt`       | public; with a key trade:read |
| `GET /api/v1/market-lifecycle/:symbol` | `fetchMarketLifecycle`  | public; with a key trade:read |
| `GET /api/v1/charts/owner-values`      | `fetchChartOwnerValues` | public; with a key trade:read |
| `POST /api/v1/orders`                  | `createOrder`           | trade:write                   |
| `DELETE /api/v1/orders/:id`            | `cancelOrder`           | trade:write                   |
| `DELETE /api/v1/orders`                | `cancelAllOrders`       | trade:write                   |
| `GET /api/v1/orders/:id`               | `fetchOrder`            | trade:read                    |
| `GET /api/v1/orders/open`              | `fetchOpenOrders`       | trade:read                    |
| `GET /api/v1/orders/closed`            | `fetchClosedOrders`     | trade:read                    |

| WebSocket stream | Permission                |
| ---------------- | ------------------------- |
| `orderbook`      | public                    |
| `trades`         | public                    |
| `ticker`         | public                    |
| `ohlcv`          | public                    |
| `orders`         | your own data; trade:read |

## Derivatives

| Route                                | Name                     | Permission                    |
| ------------------------------------ | ------------------------ | ----------------------------- |
| `GET /api/v1/funding-rate/:symbol`   | `fetchFundingRate`       | public; with a key trade:read |
| `GET /api/v1/futures/order-types`    | `fetchFuturesOrderTypes` | public; with a key trade:read |
| `GET /api/v1/positions`              | `fetchPositions`         | trade:read                    |
| `POST /api/v1/positions/leverage`    | `setLeverage`            | trade:write                   |
| `POST /api/v1/positions/margin-mode` | `setMarginMode`          | trade:write                   |

| WebSocket stream | Permission                |
| ---------------- | ------------------------- |
| `positions`      | your own data; trade:read |

## Funding

No deposit or withdrawal route is on the trading API: withdrawals are never reachable with a key, and deposits are made from the signed-in app.

## Accounts

| Route                         | Name               | Permission |
| ----------------------------- | ------------------ | ---------- |
| `GET /api/v1/account/balance` | `fetchBalance`     | trade:read |
| `GET /api/v1/account/fees`    | `fetchTradingFees` | trade:read |
| `GET /api/v1/account/trades`  | `fetchMyTrades`    | trade:read |

| WebSocket stream | Permission                |
| ---------------- | ------------------------- |
| `balance`        | your own data; trade:read |

The live inventory, GET /api/v1/capabilities, also lists the position and statement routes beyond this table, with their refusals.
