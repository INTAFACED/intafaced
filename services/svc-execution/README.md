# svc-execution

Bounded execution-service foundations: sealed house-tenancy controls plus partial OMS/SOR/EMS, external arbitrage, and external market-making doors.

This is not the complete professional execution product. It does not provide durable whole-order lifecycle ownership, care/staged orders, desk handoff, allocations, independent drop copy, full best-execution reconstruction, or production-proven recovery and capacity. Internal house execution remains blocked by the accepted owner ruling. Bounded TCA (`execution.oms.tca.run`) reads the EMS journal and named observations only.

## Current boundaries

- `execution.oms.plan` reuses `@intafaced/venue-adapter` routing over caller-supplied quotes and mandatory cost terms. Planning does not submit.
- `execution.oms.execute`, `cancel`, and `fetch` call explicitly wired venue adapters. Submit failure is reported rather than converted into a fill.
- `openOrders`, `balances`, `positions`, `rails`, `funding`, `borrow`, `latency`, `markets`, and `snapshot` expose venue observations without making them internal order, balance, position, or finality truth.
- `execution.oms.ems.list/get` reads an acknowledgement journal populated by successful submit responses. `EXECUTION_EMS_STORE_PATH` selects an append-only JSONL file; parent, pause, and fill journals sit beside it. Blank path refuses boot (`execution.algo_store_path_unset`) — never in-memory parents, pauses, or fills. Tests may inject in-memory stores. This journal is not a complete OMS or independent drop copy.
- `execution.oms.retryHedge` retries one listed failed EMS hedge child on a live TWAP/VWAP/POV parent. Venue is the stored child venue; residual stays on the parent. Paper / not-live / missing child or parent refuse. This never invents a venue or fill and never submits a replacement hedge.
- `execution.oms.tca.run` is a read-only PX-S05 TCA run over that journal. Fill VWAP uses EMS fills only. Decision/arrival/interval VWAP-TWAP/midpoint/close/quoted-spread/client benchmarks each declare source; missing capture, checksum, license, book, mid, prints, or mixed fee assets yield `UNAVAILABLE` for that benchmark, never a fabricated mark. It posts nothing to the ledger.
- `execution.arb.scan/planLegs/executeLegs` supplies bounded external arbitrage helpers. Leg submission is sequential and may partially succeed; it is not atomic execution.
- `execution.mm.quote/hedge` supplies external-only quote and hedge planning. It does not authorize internal/affiliate market making, invent quotes, or hold inventory.
- `execution.tenant.describe/kill` retains the sealed tenant description and kill switch. The kill applies before authorized tenant execution.

All protected procedures use the edge HMAC principal under `/trpc` (edge mount `/api/execution`). The policy catalog is public; protected read doors require `admin:read`. OMS mutations, `execution.arb.scan/planLegs/executeLegs`, `execution.mm.quote/hedge`, `execution.tenant.kill`, and HTTP OMS POSTs require service HMAC as `svc-execution` — session `admin:write` is not a writer.

Live slices reserve retained quantity and journal the original parent, operator, venue, symbol, side, quantity, limit and child identity before submission. A lost acknowledgement retains that reservation and refuses another unresolved child; existing fetch/cancel observations provide reconciliation. The journals assume one service process owns their paths and do not provide atomic updates across files or an exactly-once venue guarantee. A partially filled cancel response remains unknown until the venue reports a terminal status.

HTTP endpoints are `GET /health` and `GET /ready`. Readiness reports the `oms-ems` stage, EMS store mode and acknowledgement count, wired external trade/account/market-data venues, credential presence, operator/public-data supplements, and `internalVenue: blocked`. A ready process does not prove venue health, complete execution lifecycle, or production maturity.

## Events

This service does not publish bus events. Venue results and the local EMS acknowledgement journal do not replace canonical order/fill events, lookup, reconciliation, or customer drop copy.

## Money and ledger

This service holds no balances and posts no ledger recipes. Venue balance observations are external evidence only. All value movement remains in existing `packages/ledger-client` recipes and the canonical ledger; this service never assembles a second book.

## Service keys: inbound doors

The OMS write doors and `/trpc` name the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. The write doors still run only for a call named svc-execution. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
