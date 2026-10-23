# svc-tax

Per-jurisdiction lot export over ledger reads. **Not** a second money book, **not** a CSV re-import, **not** counsel.

Blank owner `TAX_JURISDICTION_MAP_JSON` refuses `tax.jurisdiction_unmapped`. Caller selects `FIFO|LIFO|HIFO` for the pack — no silent country default. Empty books return an empty pack, never a fabricated `$0` PnL. Missing lot/cost-basis is named unknown (`tax.cost_basis_unavailable` / `tax.lot_underflow`) — never an invented pairing or a `0` basis. Amounts are decimal strings. Completeness is OWNER map: packs stamp `complete: false` and residual `tax.export_incomplete`; `complete: true` is refused. Never invent jurisdictions.

A year pack lists each sub-account's fills and converts with `fee` and `makerRebate` in separate columns. Realised gain on a line is proceeds minus that line's cost basis, and only when both are present. A null basis stays null on that sub-account, stays in `tax.cost_basis_unavailable`, and is not copied onto another sub-account. Rows outside the owner-published `TAX_HISTORY_YEARS` window are left out. The ledger history wire has no sub-account parent index, fee, maker rebate, or cost basis, so boot leaves `subAccountBooks: "unwired"` and invents no rows until both readers are attached.

## API

| Procedure       | Scope       | Input                          | Output                                                                               |
| --------------- | ----------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `health`        | public      | —                              | `{ ok, service }` — liveness, not a custody claim                                    |
| `exportPreview` | `tax:read`  | `{ lotMethod }`                | preview; amounts as strings                                                          |
| `exportPack`    | `tax:read`  | `{ lotMethod }`                | JSON pack (`bodyBase64`), including `subAccounts`                                    |
| `lotBook`       | `tax:read`  | `{ method? }`                  | profit and loss indicator from the caller's own fills (see below)                    |
| `setLotMethod`  | `tax:write` | `{ assetId, method }`          | the caller's method for the account (`assetId` null) or a coin; `method` null clears |
| `setDayMethod`  | `tax:write` | `{ day, assetId, method }`     | the caller's method for one UTC day, one coin or all (`assetId` null)                |
| `pickSaleLot`   | `tax:write` | `{ saleTxId, assetId, lotId }` | the lot one of the caller's sales draws on first; `lotId` null clears                |

## Lot book (profit and loss indicator)

`lotBook` is a self-only read of the caller's own ledger, labelled `indicator_not_tax_advice`. It is not the year pack and is not gated by the jurisdiction map. Without a method it applies the caller's saved choices (below); `{ method }` (`FIFO`, `LIFO`, `HIFO` or `AVERAGE`) previews that one method for every sale (`preview: true`, no saved choice or pick applied). Anything else refuses.

**Saved choices.** The caller may save a method for the whole account, for one coin, and for one UTC day (one coin or all), and pick the lot one sale draws on first. A sale's method, most specific first: that coin on that day, every coin that day, the coin, the account, then the product default FIFO; each sale says which (`method`, `methodSource`). A picked lot is drawn first (as much as is still open); the rest goes by the method. A pick must name a sale and a lot of the same coin in the caller's own book, with the lot arriving first, or it is refused (`tax.lot_pick_invalid`); a saved pick whose lot is no longer open at the sale is named (`tax.lot_pick_unusable`) and the method decides. Choices are settings rows in schema `tax` (`drizzle/`), keyed by the caller; they move no value and post nothing. `DATABASE_URL` unset: the book uses the default and says `choices: { status: 'unwired' }`, and a save refuses `tax.database_url_unset` (`tax.database_pool_max_unset` when only the pool size is blank).

**Lots.** Every arrival of a coin is a lot with an id (`lot:<txId>:<asset>`, then `:2`, `:3` when one transaction credits the same coin again), when it arrived, its source (`trade`, `deposit`, `reward`, `transfer_in`, `other_in`), quantity, what is left, its cost and the cost of what is left, and days held. A bought lot is joined from two ledger reads, the received leg (on `available`) and the paying leg (on that order's `hold` account), on the transaction; against USDT, USDC or USD it has a real dollar cost (the fee is already out of the received leg). Fills against a house quote (`trade.fill.mm_maker`) are read like any other fill. Dollar coins count as exactly 1 USD and are not lots. Released holds, reversed withdrawals, margin release, unstake, earn withdrawals and fee corrections are the customer's own coins coming back, not new lots.

**Value on arrival.** A lot that was not bought is valued at the price when it arrived, read from svc-trade's public candles (`TRADE_URL`): USDT market, else USDC; the close of the last one-minute candle that opened at or before the arrival, else the last hourly or daily candle that had already ended by then. Never a later price, never today's price, never zero. The market, candle size and candle time are returned so the screen names the source. No price (or no `TRADE_URL`) leaves the value null with `tax.price_at_time_unavailable`.

**Cost of an arrival** is the owner's `TAX_DEPOSIT_BASIS`: `market` (the value on arrival) or `customer` (unknown until the customer enters one). Blank: unknown, with `tax.deposit_basis_policy_unset`.

**Sales.** Each sale lists the lots it used (`matches`). A part that draws on a lot with no cost has unknown cost and result; HIFO and AVERAGE are unknown as a whole when any open lot has no cost. A sale bigger than every open lot is `unmatchedQty` (`tax.lot_underflow`). AVERAGE restates the open lots at the pool's average exactly.

**Honesty rules.** If an asset is held in a different quantity than its open lots, which lot is open is not known, so its cost, unrealised and sale results are null (`tax.lot_book_unreconciled`). Hitting the read ceiling is `tax.lot_book_incomplete` and no figure is shown. Short or long term is not classified: the term rule is not published (`termClass: null`, `termRule` names `tax.term_rule_unset`). Unrealised value is the caller's to join with current prices.

## Events

None. This service publishes no subjects.

## Ledger

Read-only. `balances` + `history` over `@intafaced/ledger-client` HTTP to svc-ledger. No recipes. No `post`. Its own Postgres schema `tax` holds only the customers' cost-basis choices: no balance, no amount.

| Read       | Why                                   |
| ---------- | ------------------------------------- |
| `balances` | current available books               |
| `history`  | lot reconstruction for those accounts |

Data lake / indexer missing → named `absent` on the pack (`tax.data_lake_unavailable`, `tax.indexer_unavailable`). A set URL is `configured` + `tax.data_lake_unprobed` / `tax.indexer_unprobed` — never `ok`. Never filled in as `$0`.

## Service keys: ledger reads

The ledger reads (balances and history) are signed with svc-tax's own key when `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set (`dual` also sends the shared secret, `keypair` the key only); unset, they are signed with the shared secret as before. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
