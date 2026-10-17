# Architecture

What is on `main` and who owns what. Every line names a path; if a path and this file disagree, the path wins and this file is the bug. Agent rules: [`AGENTS.md`](../AGENTS.md).

Count check: `ls apps` (4), `ls services` (26 directories, 25 run in compose), `ls packages` (24).

## Apps

| App               | What it is                                                                                 | Where it runs                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/customer`   | The customer site. React 19 and Vite (`apps/customer/package.json`).                       | Compose service `vendor-shell` builds `apps/customer/Dockerfile` on `8090:80` (`docker-compose.apps.yml:1787`, `:1799`). Dev server: port 3200 (`apps/customer/package.json:7`). |
| `apps/admin`      | The operator console. Next.js 15 with React 19 (`apps/admin/package.json`).                | Compose service `admin` on `3100:3100` (`docker-compose.apps.yml:1883`, `:1918`).                                                                                                |
| `apps/invitation` | The public join questionnaire. React and Vite, its own build.                              | Not a compose service (`docker-compose.apps.yml:1754-1757`). A separate project serves its `dist/`.                                                                              |
| `apps/mobile`     | Capacitor wrapper around the React customer site (`apps/mobile/package.json` description). | Not a compose service. Staged by `apps/mobile/scripts/build-wrap.mjs`.                                                                                                           |

The customer container is nginx over the built files. It sends unknown paths to `index.html` (`apps/customer/nginx.conf:41`), proxies `/api/` to `svc-edge:4000` (`:47`) and `/ws/` to `svc-ws:4014` (`:59`). Rooms are declared in `apps/customer/src/app/navigation.ts` and `screens.ts`; `apps/customer/src/app/feature-registry.ts` still holds rows marked `hidden` that redirect, which the product law (AGENTS.md) says to remove. No `/chain`, `/dex` or `/protocol` room exists in `apps/customer/src` yet (`navigation.test.ts:34` only checks `/chain` is refused); adding them is open work.

`vendor/upstream-exchange` is imported third-party source. Its Vue front end `05_Web_Front` is retained and not served (`docker-compose.apps.yml:1751`). Do not build on it. Its Java wallet service cannot credit a balance: `MemberWalletService.increaseBalance` throws (line 310 of `MemberWalletService.java` under `vendor/upstream-exchange/00_framework/core/src/main/java/`).

## Services

All 25 run in `docker-compose.apps.yml`. `services/svc-matching-rust-stage1` is a Rust prototype outside compose; the TypeScript engine stays the default (`services/svc-matching-rust-stage1/src/lib.rs:3-4`). `services/svc-chain` and `services/svc-bridge` do not exist. Postgres is one database with one schema and one role per service, so in dev a service cannot read another's tables (`tooling/infra/postgres-init/01-service-schemas.sql:3-8`).

| Service           | Owns (extend this folder, do not add a second copy)                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `svc-ledger`      | The only balance store: double-entry, hash-chained, `PostgresLedger` (`src/ledger/postgres-ledger.ts:63`). Platform-wide posting freeze (`src/ledger/freeze.ts`), reconciliation (`src/ledger/reconcile.ts`). |
| `svc-identity`    | Accounts, sessions, passkeys, API keys, KYC, rank (`src/auth`, `src/kyc`, `src/rank`). Freezing one account is `freezeIdentity` (`src/auth/auth-service.ts:1422`).                                            |
| `svc-edge`        | Turns a bearer token into the signed principal every service requires (`src/principal-exchange.ts`). Port 4000.                                                                                               |
| `svc-token`       | IFC emission schedule and staking ladder; the stake value lives in the ledger (`README.md:5`, `:7`).                                                                                                          |
| `svc-trade`       | Order lifecycle and fees: `src/spot`, `src/algo`, `src/futures`, `src/otc`, `src/convert`, `src/copy`, `src/controls`. Decides an order is allowed and funded; matches nothing (`README.md:5`).               |
| `svc-matching`    | The house order book, in memory, nothing else (`README.md:3`; `src/engine`).                                                                                                                                  |
| `svc-ws`          | Public depth and trade stream, plus the authenticated private `orders`, `fills`, `positions` channels (`src/private/gateway.ts:20`, `:48`). Port 4014.                                                        |
| `svc-fix`         | Java FIX gateway (`pom.xml`; tests run Maven then Vitest, `package.json:18`).                                                                                                                                 |
| `svc-execution`   | Partial execution management and external arbitrage and market-making doors; it has no whole-order lifecycle (`README.md:3-5`). The order store is `svc-trade`.                                               |
| `svc-pay`         | Merchant payments, settlement into the ledger, rails behind `RailAdapter` (`src/rails`), `src/fraud`, `src/subscription-router.ts`, `src/kyb-router.ts`.                                                      |
| `svc-p2p`         | Peer-to-peer trades with ledger-backed escrow; holds no balance (`README.md:7`).                                                                                                                              |
| `svc-bank`        | Spaces, earn, loans, cards, ramps, transfers over ledger accounts (`src/spaces`, `src/earn`, `src/loans`, `src/cards`, `src/ramps`, `src/transfers`).                                                         |
| `svc-blueprint`   | Identity Blueprint profile, crew pairing (`src/matching/crew-matching.ts`). Not the order engine.                                                                                                             |
| `svc-agents`      | Agent fleet runtime, model gateway, per-user metering billed through the ledger (`README.md:5`).                                                                                                              |
| `svc-academy`     | Lobbies and curriculum (`README.md:3`).                                                                                                                                                                       |
| `svc-notify`      | Bus events to inbox rows and channels; price alerts (`README.md:3`, `src/alerts`).                                                                                                                            |
| `svc-support`     | Tickets and knowledge base (`README.md:3`).                                                                                                                                                                   |
| `svc-market`      | Vendor listings and purchases. Not the price feed (`README.md:3`).                                                                                                                                            |
| `svc-tax`         | Per-jurisdiction lot export from ledger reads (`README.md:3`).                                                                                                                                                |
| `svc-quant`       | Paper strategy sandbox; its fills never post to the ledger (`README.md:4`; its marks in `src/sandbox/book.ts:4-6` are fixtures, not a live feed).                                                             |
| `svc-ops`         | Operator CRM, team directory, warehouse revenue; not a money book (`README.md:3`).                                                                                                                            |
| `svc-mining-pool` | Mining shares and epoch payouts (`src/pplns.ts`, `src/epoch-jobs.ts`). No README.                                                                                                                             |
| `svc-dex`         | Protocol Plane front door: quotes; never posts (`README.md:5`; `src/quote`).                                                                                                                                  |
| `svc-protocol`    | Non-custodial smart accounts and Solidity under `contracts/`; the venue contract stays `audited: false` (`contracts/venue/SovereignVenue.sol:11`).                                                            |
| `svc-indexer`     | Chain read models; posts no ledger transaction (`README.md:7`).                                                                                                                                               |

Compose also runs `migrate` (one-shot, runs every service's migrations: `tooling/infra/migrate-all.mjs`), `litellm`, `academy-minio`, `livekit`, and the two apps.

## Packages that matter

| Package                                     | Role                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/ledger-client`                    | The only way a service touches balances (`src/index.ts:2`). `recipes/` are the reviewable money moves; `money.ts` is scaled bigint (`:26`); `memory-ledger.ts` is the test reference. `ReadOnlyLedgerClient` has no write method (`src/client.ts:51`). |
| `packages/contracts`                        | tRPC building blocks and the edge principal check; `scopedProcedure` (`src/trpc.ts`).                                                                                                                                                                  |
| `packages/events`                           | The NATS bus and the subject catalog (`src/catalog.ts`); `idempotent` consumer wrapper (`src/bus.ts`).                                                                                                                                                 |
| `packages/config`                           | Env loading that fails at boot (`src/env.ts`), feature flags, `checkAccess` jurisdiction matrix (`src/jurisdiction.ts`).                                                                                                                               |
| `packages/auth`                             | Token verification and scopes (imported by `svc-edge`).                                                                                                                                                                                                |
| `packages/exchange-contract`                | The CCXT-shaped public exchange API served to traders (`src/schemas.ts:5`).                                                                                                                                                                            |
| `packages/venue-contracts`, `venue-adapter` | Sequenced venue book types (`venue-contracts/src/book.ts`); routing across venues (`venue-adapter/src/consolidated-book.ts`).                                                                                                                          |
| `packages/db`, `telemetry`, `i18n`, `ui`    | Drizzle helpers, tracing, translations, shared React pieces.                                                                                                                                                                                           |

## Money, in one paragraph

A service decides an action is allowed, then calls `svc-ledger` over HTTP through `packages/ledger-client` (`src/http-client.ts`; handler `svc-ledger/src/s2s-http.ts`) with a business key, so a retry finds the original post. For a spot order, `svc-trade` posts `orderHold` before it calls `svc-matching` (`services/svc-trade/src/spot/trade-service.ts:1598`, `:1618`), and a fill posts `tradeFill` (`:2888`). Every post takes `FOR UPDATE` on the single `chain_tip` row (`services/svc-ledger/src/ledger/postgres-ledger.ts:113`), so posting is one serial line for the whole platform. A scheduled reconciliation proves the book; a failed or throwing proof writes the platform-wide posting freeze (`services/svc-ledger/src/ledger/scheduled-reconcile-tick.ts:8-19`, timer at `services/svc-ledger/src/index.ts:118`). Protocol Plane contracts hold their own state on chain and are not the house book (`services/svc-indexer/README.md:7`).

## Run it locally

Node 20 or newer and pnpm 10 (`package.json:6-9`).

```bash
pnpm install
cp .env.example .env     # read its header: EDGE_PRINCIPAL_SECRET and INTERNAL_SERVICE_SECRET must be set
pnpm infra:up            # docker compose up -d: postgres, redis, nats, otel, tempo, prometheus, grafana, two throwaway anvil chains
pnpm platform:up         # docker compose -f docker-compose.apps.yml up -d --build: infra plus every service and both apps
```

`platform:up` includes `docker-compose.yml` (`docker-compose.apps.yml:24`), so it needs no separate `infra:up`. Compose refuses to start without `APP_ENV` (`docker-compose.apps.yml:65`). Host ports: Postgres 5433, Redis 6380, NATS 4222 and 8222, Grafana 3001, Prometheus 9090, Tempo 3200, anvil 8545 and 8546 (`docker-compose.yml`), edge 4000, ws 4014, customer 8090, admin 3100. Tempo and the customer dev server both want 3200.

Tests: `pnpm test` is `turbo run test`; most packages use Vitest. Single package: `pnpm --filter @intafaced/<name> test`. Per-service Definition of Done: `pnpm gate`. Broad local check: `pnpm verify`.

## Decisions and runbooks

Settled, hard-to-reverse decisions: [`docs/adr/`](adr/). Operations procedures: [`docs/runbooks/`](runbooks/). Newer ADRs win over older ones. All other files under `docs/` are history, not instructions.
