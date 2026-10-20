# svc-tax

Per-jurisdiction lot export over ledger reads. **Not** a second money book, **not** a CSV re-import, **not** counsel.

Blank owner `TAX_JURISDICTION_MAP_JSON` refuses `tax.jurisdiction_unmapped`. Caller selects `FIFO|LIFO|HIFO` — no silent country default. Empty books return an empty pack, never a fabricated `$0` PnL. Missing lot/cost-basis is named unknown (`tax.cost_basis_unavailable` / `tax.lot_underflow`) — never an invented pairing or a `0` basis. Amounts are decimal strings. Completeness is OWNER map: packs stamp `complete: false` and residual `tax.export_incomplete`; `complete: true` is refused. Never invent jurisdictions.

A year pack lists each sub-account's fills and converts with `fee` and `makerRebate` in separate columns. Realised gain on a line is proceeds minus that line's cost basis, and only when both are present. A null basis stays null on that sub-account, stays in `tax.cost_basis_unavailable`, and is not copied onto another sub-account. Rows outside the owner-published `TAX_HISTORY_YEARS` window are left out. The ledger history wire has no sub-account parent index, fee, maker rebate, or cost basis, so boot leaves `subAccountBooks: "unwired"` and invents no rows until both readers are attached.

## API

| Procedure       | Scope      | Input           | Output                                                            |
| --------------- | ---------- | --------------- | ----------------------------------------------------------------- |
| `health`        | public     | —               | `{ ok, service }` — liveness, not a custody claim                 |
| `exportPreview` | `tax:read` | `{ lotMethod }` | preview; amounts as strings                                       |
| `exportPack`    | `tax:read` | `{ lotMethod }` | JSON pack (`bodyBase64`), including `subAccounts`                 |
| `lotBook`       | `tax:read` | `{ method? }`   | profit and loss indicator from the caller's own fills (see below) |

## Lot book (profit and loss indicator)

`lotBook` is a self-only read of the caller's own trade fills, labelled `indicator_not_tax_advice`. It is not the year pack and is not gated by the jurisdiction map. Each fill is joined from two ledger reads: the received leg (from the `available` account) and the paying leg (from that order's `hold` account), on the transaction. A coin bought or sold against USDT, USDC or USD has a real dollar cost or proceeds (the fee is already out of the received leg). A trade between two other coins has no dollar figure; coins that arrived by deposit or transfer have no lot, and a sale that reaches them is `unmatchedQty` with `realizedUsd: null` (`tax.lot_underflow`). Dollar coins (USDT, USDC, USD) count as exactly 1 USD. Fills against a house quote (`trade.fill.mm_maker`, which covers convert and OTC) are read like any other fill, and each received leg is joined to its own order's paying leg, so a self-trade is not crossed. The book only knows coins that came from fills: if an asset is held in a different quantity than its open lots (a deposit, a transfer in or out, interest), which lot is open is not known, so that asset's cost, unrealised and sale results are null (`tax.lot_book_unreconciled`). Hitting the read ceiling is named `tax.lot_book_incomplete` and then no result or cost is shown. The method defaults to FIFO (a product default, changeable per call); unrealised value is the caller's to join with current prices.

## Events

None. This service publishes no subjects.

## Ledger

Read-only. `balances` + `history` over `@intafaced/ledger-client` HTTP to svc-ledger. No recipes. No `post`.

| Read       | Why                                   |
| ---------- | ------------------------------------- |
| `balances` | current available books               |
| `history`  | lot reconstruction for those accounts |

Data lake / indexer missing → named `absent` on the pack (`tax.data_lake_unavailable`, `tax.indexer_unavailable`). A set URL is `configured` + `tax.data_lake_unprobed` / `tax.indexer_unprobed` — never `ok`. Never filled in as `$0`.

## Service keys: ledger reads

The ledger reads (balances and history) are signed with svc-tax's own key when `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set (`dual` also sends the shared secret, `keypair` the key only); unset, they are signed with the shared secret as before. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

The lot book also marks a coin as outside the book when it reached the customer other than by a fill (a deposit, a transfer in). Sales of that coin have unknown cost and result, whether or not any is still held. Released holds, reversed withdrawals, margin release and unstake are the customer's own coins coming back and do not count.
