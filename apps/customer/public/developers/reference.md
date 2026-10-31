# API reference

Every trading REST route and WebSocket stream, under its product, with the permission a key needs. A route marked public also answers without a key.

## General

| Route                      | Name                | Permission                    |
| -------------------------- | ------------------- | ----------------------------- |
| `GET /api/v1/time`         | `fetchTime`         | public; with a key trade:read |
| `GET /api/v1/capabilities` | `fetchCapabilities` | public; with a key trade:read |
| `GET /api/v1/routes`       | `fetchRoutes`       | public; with a key trade:read |

## Spot

| Route                                               | Name                    | Permission                    |
| --------------------------------------------------- | ----------------------- | ----------------------------- |
| `GET /api/v1/markets`                               | `fetchMarkets`          | public; with a key trade:read |
| `GET /api/v1/ticker/:symbol`                        | `fetchTicker`           | public; with a key trade:read |
| `GET /api/v1/tickers`                               | `fetchTickers`          | public; with a key trade:read |
| `GET /api/v1/orderbook/:symbol`                     | `fetchOrderBook`        | public; with a key trade:read |
| `GET /api/v1/ohlcv/:symbol`                         | `fetchOHLCV`            | public; with a key trade:read |
| `GET /api/v1/trades/:symbol`                        | `fetchTrades`           | public; with a key trade:read |
| `GET /api/v1/market-halt/:symbol`                   | `fetchMarketHalt`       | public; with a key trade:read |
| `GET /api/v1/market-lifecycle/:symbol`              | `fetchMarketLifecycle`  | public; with a key trade:read |
| `GET /api/v1/charts/owner-values`                   | `fetchChartOwnerValues` | public; with a key trade:read |
| `GET /api/v1/fees/published`                        | `fetchPublishedFees`    | public; with a key trade:read |
| `POST /api/v1/orders`                               | `createOrder`           | trade:write                   |
| `DELETE /api/v1/orders/:id`                         | `cancelOrder`           | trade:write                   |
| `DELETE /api/v1/orders`                             | `cancelAllOrders`       | trade:write                   |
| `GET /api/v1/orders/:id`                            | `fetchOrder`            | trade:read                    |
| `GET /api/v1/orders/open`                           | `fetchOpenOrders`       | trade:read                    |
| `GET /api/v1/orders/closed`                         | `fetchClosedOrders`     | trade:read                    |
| `POST /api/v1/orders/preview`                       | `previewOrder`          | trade:write                   |
| `POST /api/v1/orders/batch-amend`                   | `batchAmendOrders`      | trade:write                   |
| `POST /api/v1/orders/batch-cancel`                  | `batchCancelOrders`     | trade:write                   |
| `POST /api/v1/markets/:marketId/orders/mass-cancel` | `massCancelOrders`      | trade:write                   |
| `POST /api/v1/orders/cancel-all-after`              | `cancelAllOrdersAfter`  | trade:write                   |
| `GET /api/v1/orders/cancel-all-after`               | `fetchCancelAllAfter`   | trade:read                    |
| `POST /api/v1/orders/batch`                         | `createOrders`          | trade:write                   |
| `PATCH /api/v1/orders/:id`                          | `editOrder`             | trade:write                   |
| `POST /api/v1/orders/:id/replace`                   | `replaceOrder`          | trade:write                   |
| `GET /api/v1/orders/:id/amendments`                 | `fetchOrderAmendments`  | trade:read                    |
| `GET /api/v1/orders/:id/trades`                     | `fetchOrderTrades`      | trade:read                    |
| `GET /api/v1/orders/by-client-id/:clientOrderId`    | `fetchOrderByClientId`  | trade:read                    |
| `GET /api/v1/orders/by-client/:clientOrderId`       | `fetchOrderByClient`    | trade:read                    |
| `DELETE /api/v1/orders/by-client-id/:clientOrderId` | `cancelOrderByClientId` | trade:write                   |
| `DELETE /api/v1/orders/by-client/:clientOrderId`    | `cancelOrderByClient`   | trade:write                   |
| `POST /api/v1/spot/positions/close`                 | `closeSpotPosition`     | trade:write                   |
| `POST /api/v1/promotions`                           | `previewPromotion`      | trade:write                   |
| `POST /api/v1/quant/live-deploy`                    | `previewLiveDeploy`     | trade:write                   |

| WebSocket stream | Door                                                   | Permission                |
| ---------------- | ------------------------------------------------------ | ------------------------- |
| `depth`          | One market per socket `/stream`                        | public                    |
| `trades`         | One market per socket `/stream`                        | public                    |
| `book`           | Many channels on one socket `/stream`                  | public                    |
| `trades`         | Many channels on one socket `/stream`                  | public                    |
| `ticker`         | Many channels on one socket `/stream`                  | public                    |
| `candles`        | Many channels on one socket `/stream`                  | public                    |
| `orders`         | Your own orders, fills and positions `/private/stream` | your own data; trade:read |
| `fills`          | Your own orders, fills and positions `/private/stream` | your own data; trade:read |

## Derivatives

| Route                                           | Name                                                           | Permission                                            |
| ----------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/v1/funding-rate/:symbol`              | `fetchFundingRate`                                             | public; with a key trade:read                         |
| `GET /api/v1/futures/order-types`               | `fetchFuturesOrderTypes`                                       | public; with a key trade:read                         |
| `GET /api/v1/funding-history/:symbol`           | `fetchFundingRateHistory`                                      | public; with a key trade:read                         |
| `GET /api/v1/futures/ticker`                    | `fetchFuturesTicker`                                           | public; with a key trade:read                         |
| `GET /api/v1/futures/tiers`                     | `fetchLeverageTiers`                                           | public; with a key trade:read                         |
| `GET /api/v1/outcomes/markets`                  | `fetchOutcomeMarkets`                                          | public; with a key trade:read                         |
| `GET /api/v1/positions`                         | `fetchPositions`                                               | trade:read                                            |
| `GET /api/v1/positions/closed`                  | `fetchClosedPositions`                                         | trade:read                                            |
| `GET /api/v1/positions/:id`                     | `fetchPosition`                                                | trade:read                                            |
| `GET /api/v1/positions/:id/margin-call`         | `fetchPositionMarginCall`                                      | trade:read                                            |
| `POST /api/v1/positions`                        | `openPosition`                                                 | trade:write                                           |
| `POST /api/v1/positions/:id/close`              | `closePositionQuantity`                                        | trade:write                                           |
| `DELETE /api/v1/positions/:id`                  | `closePosition`                                                | trade:write                                           |
| `POST /api/v1/positions/margin`                 | `addIsolatedMargin`                                            | trade:write                                           |
| `POST /api/v1/positions/margin/reduce`          | `reduceIsolatedMargin`                                         | trade:write                                           |
| `GET /api/v1/futures/adl-disclosure`            | `fetchAdlDisclosure`                                           | trade:read                                            |
| `POST /api/v1/futures/adl-disclosure/ack`       | `ackAdlDisclosure`                                             | trade:write                                           |
| `GET /api/v1/futures/adl-events`                | `fetchAdlDisclosureEvents`                                     | trade:read                                            |
| `POST /api/v1/positions/leverage`               | `setLeverage`                                                  | trade:write                                           |
| `POST /api/v1/positions/margin-mode`            | `setMarginMode`                                                | trade:write                                           |
| `GET /api/v1/account/gated-list`                | `fetchGatedList`                                               | trade:read                                            |
| `GET /api/v1/positions/:id/liquidation`         | `fetchPositionLiquidation`                                     | trade:read                                            |
| `GET /api/v1/futures/liquidations`              | `fetchLiquidations`                                            | trade:read                                            |
| `GET /api/v1/futures/payouts`                   | `fetchFuturesPayouts`                                          | trade:read                                            |
| `GET /api/v1/positions/:id/funding-payments`    | `fetchFundingPayments`                                         | trade:read                                            |
| `POST /api/v1/futures/positions/close-all`      | `closeAllPositions`                                            | trade:write                                           |
| `GET /api/v1/futures/margin-summary`            | `fetchMarginSummary`                                           | trade:read                                            |
| `GET /api/v1/futures/position-mode`             | `fetchPositionMode`                                            | trade:read                                            |
| `PUT /api/v1/futures/position-mode`             | `setPositionMode`                                              | trade:write                                           |
| `POST /api/v1/futures/leverage`                 | `setFuturesLeverage`                                           | trade:write                                           |
| `POST /api/v1/futures/calculator`               | `calculateFuturesRisk`                                         | trade:write                                           |
| `GET /api/v1/futures/collateral`                | `fetchCollateral`                                              | trade:read                                            |
| `POST /api/v1/futures/conditional-orders`       | `createConditionalOrder`                                       | trade:write                                           |
| `GET /api/v1/futures/conditional-orders`        | `fetchConditionalOrders`                                       | trade:read                                            |
| `GET /api/v1/futures/conditional-orders/:id`    | `fetchConditionalOrder`                                        | trade:read                                            |
| `DELETE /api/v1/futures/conditional-orders/:id` | `cancelConditionalOrder`                                       | trade:write                                           |
| `PUT /api/v1/positions/:id/protection`          | `setPositionProtection`                                        | trade:write                                           |
| `GET /api/v1/futures/entry-protection`          | `fetchEntryProtection`                                         | trade:read                                            |
| `POST /api/v1/futures/orders`                   | `createFuturesOrder`                                           | trade:write                                           |
| `GET /api/v1/futures/orders`                    | `fetchFuturesOrders`                                           | trade:read                                            |
| `DELETE /api/v1/futures/orders/:id`             | `cancelFuturesOrder`                                           | trade:write                                           |
| `POST /api/v1/futures/orders/split`             | `createSplitFuturesOrder` · mounted only with futures matching | trade:write                                           |
| `POST /api/v1/positions/:id/reverse`            | `reversePosition` · mounted only with futures matching         | trade:write                                           |
| `POST /api/v1/positions/preview`                | `previewPosition`                                              | trade:write                                           |
| `POST /api/v1/greeks/what-if`                   | `previewGreeksWhatIf`                                          | trade:write                                           |
| `POST /api/v1/greeks/delta-hedge`               | `previewDeltaHedge`                                            | trade:write                                           |
| `POST /api/v1/outcomes/orders`                  | `createOutcomeOrder`                                           | trade:write                                           |
| `POST /api/v1/outcomes/markets/publish`         | `publishOutcomeMarket`                                         | service to service only; no key or session reaches it |
| `POST /api/v1/outcomes/settle`                  | `settleOutcomeMarket`                                          | service to service only; no key or session reaches it |

| WebSocket stream        | Door                                                   | Permission                |
| ----------------------- | ------------------------------------------------------ | ------------------------- |
| `futures.mark.<symbol>` | Many channels on one socket `/stream`                  | public                    |
| `positions`             | Your own orders, fills and positions `/private/stream` | your own data; trade:read |

## Funding

No deposit or withdrawal route is on the trading API: withdrawals are never reachable with a key, and deposits are made from the signed-in app.

## Accounts

| Route                                          | Name                          | Permission              |
| ---------------------------------------------- | ----------------------------- | ----------------------- |
| `GET /api/v1/account/balance`                  | `fetchBalance`                | trade:read              |
| `GET /api/v1/account/fees`                     | `fetchTradingFees`            | trade:read              |
| `GET /api/v1/account/trades`                   | `fetchMyTrades`               | trade:read              |
| `GET /api/v1/ledger`                           | `fetchLedger`                 | trade:read              |
| `POST /api/v1/statements`                      | `createStatementExport`       | trade:write             |
| `GET /api/v1/statements/:id`                   | `fetchStatementExport`        | trade:read              |
| `GET /api/v1/statements/:id/file`              | `fetchStatementExportFile`    | trade:read              |
| `GET /api/v1/account/fee-tier`                 | `fetchFeeTier`                | trade:read              |
| `GET /api/v1/account/market-lifecycle/:symbol` | `fetchAccountMarketLifecycle` | trade:read              |
| `GET /api/v1/convert/export`                   | `fetchConvertExport`          | trade:read              |
| `GET /api/v1/copy/export`                      | `fetchCopyExport`             | trade:read              |
| `GET /api/v1/rfq/export`                       | `fetchRfqExport`              | trade:read              |
| `GET /api/v1/vip/applications`                 | `fetchVipApplications`        | trade:read              |
| `POST /api/v1/vip/applications`                | `applyForVip`                 | trade:write             |
| `GET /api/v1/admin/orders/open`                | `fetchAdminOpenOrders`        | trade:read + admin:read |
| `GET /api/v1/admin/fees`                       | `fetchAdminFees`              | trade:read + admin:read |

| WebSocket stream | Door                                        | Permission                |
| ---------------- | ------------------------------------------- | ------------------------- |
| `drop_copy`      | Drop copy of your fills `/drop-copy/stream` | your own data; trade:read |

This table lists every trading REST route, each once. The live inventory, GET /api/v1/routes, lists the same routes with who may call each and the scopes a key needs; a route marked as needing futures matching is mounted only while futures orders go through matching.

The live stream inventory, GET /ws/streams, lists every channel the stream service serves and whether its door is up.
