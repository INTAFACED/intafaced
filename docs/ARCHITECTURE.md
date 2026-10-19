# Architecture

What is on `main` and who owns what. Every line names a path; if a path and this file disagree, the path wins and this file is the bug. Agent rules: [`AGENTS.md`](../AGENTS.md).

Count check: `ls apps` (4), `ls services` (26 directories), `ls packages` (24). Which services run in compose, their ports and required env: [`SERVICES.md`](SERVICES.md), generated from the code.

## Apps

| App               | What it is                                                                                 | Where it runs                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/customer`   | The customer site. React 19 and Vite (`apps/customer/package.json`).                       | Compose service `vendor-shell` builds `apps/customer/Dockerfile` on `8090:80` (`docker-compose.apps.yml`). Dev server: port 3200 (`apps/customer/package.json`). |
| `apps/admin`      | The operator console. Next.js 15 with React 19 (`apps/admin/package.json`).                | Compose service `admin` on `3100:3100` (`docker-compose.apps.yml`).                                                                                              |
| `apps/invitation` | The public join questionnaire. React and Vite, its own build.                              | Not a compose service (`docker-compose.apps.yml`). A separate project serves its `dist/`.                                                                        |
| `apps/mobile`     | Capacitor wrapper around the React customer site (`apps/mobile/package.json` description). | Not a compose service. Staged by `apps/mobile/scripts/build-wrap.mjs`.                                                                                           |

The customer container is nginx over the built files. It sends unknown paths to `index.html` (`apps/customer/nginx.conf`), proxies `/api/` to `svc-edge:4000` and `/ws/` to `svc-ws:4014`. Rooms are declared in `apps/customer/src/app/navigation.ts` and `screens.ts`; `apps/customer/src/app/feature-registry.ts` lists `blocked` rooms: reachable, with the reason and unlock shown; no row is `hidden`. `/chain`, `/dex` and `/protocol` are reachable rooms with named blockers (`apps/customer/src/app/navigation.ts`, `apps/customer/src/features/protocol/ParkedProtocolRoom.tsx`).

`vendor/upstream-exchange` is imported third-party source. Its old Vue front end was deleted (git history keeps it). Its Java wallet service cannot credit a balance: `MemberWalletService.increaseBalance` throws (line 310 of `MemberWalletService.java` under `vendor/upstream-exchange/00_framework/core/src/main/java/`).

## Services

Every one except the Rust prototype is in `docker-compose.apps.yml` (`svc-fix` only under its `fix` profile). `services/svc-matching-rust-stage1` is a Rust prototype outside compose; the TypeScript engine stays the default (`services/svc-matching-rust-stage1/src/lib.rs`). `services/svc-chain` and `services/svc-bridge` do not exist. Postgres is one database with one schema and one role per service, so in dev a service cannot read another's tables (`tooling/infra/postgres-init/01-service-schemas.sql`).

| Service           | Owns (extend this folder, do not add a second copy)                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `svc-ledger`      | The only balance store: double-entry, hash-chained, `PostgresLedger` (`src/ledger/postgres-ledger.ts`). Platform-wide posting freeze (`src/ledger/freeze.ts`), reconciliation (`src/ledger/reconcile.ts`). |
| `svc-identity`    | Accounts, sessions, passkeys, API keys, KYC, rank (`src/auth`, `src/kyc`, `src/rank`). Freezing one account is `freezeIdentity` (`src/auth/auth-service.ts`).                                              |
| `svc-edge`        | Turns a bearer token into the signed principal every service requires (`src/principal-exchange.ts`). Port 4000.                                                                                            |
| `svc-token`       | IFC emission schedule and staking ladder; the stake value lives in the ledger (`README.md`).                                                                                                               |
| `svc-trade`       | Order lifecycle and fees: `src/spot`, `src/algo`, `src/futures`, `src/otc`, `src/convert`, `src/copy`, `src/controls`. Decides an order is allowed and funded; matches nothing (`README.md`).              |
| `svc-matching`    | The house order book, in memory, nothing else (`README.md`; `src/engine`).                                                                                                                                 |
| `svc-ws`          | Public depth and trade stream, plus the authenticated private `orders`, `fills`, `positions` channels (`src/private/gateway.ts`). Port 4014.                                                               |
| `svc-fix`         | Java FIX gateway (`pom.xml`; tests run Maven then Vitest, `package.json`).                                                                                                                                 |
| `svc-execution`   | Partial execution management and external arbitrage and market-making doors; it has no whole-order lifecycle (`README.md`). The order store is `svc-trade`.                                                |
| `svc-pay`         | Merchant payments, settlement into the ledger, rails behind `RailAdapter` (`src/rails`), `src/fraud`, `src/subscription-router.ts`, `src/kyb-router.ts`.                                                   |
| `svc-p2p`         | Peer-to-peer trades with ledger-backed escrow; holds no balance (`README.md`).                                                                                                                             |
| `svc-bank`        | Spaces, earn, loans, cards, ramps, transfers over ledger accounts (`src/spaces`, `src/earn`, `src/loans`, `src/cards`, `src/ramps`, `src/transfers`).                                                      |
| `svc-blueprint`   | Identity Blueprint profile, crew pairing (`src/matching/crew-matching.ts`). Not the order engine.                                                                                                          |
| `svc-agents`      | Agent fleet runtime, model gateway, per-user metering billed through the ledger (`README.md`).                                                                                                             |
| `svc-academy`     | Lobbies and curriculum (`README.md`).                                                                                                                                                                      |
| `svc-notify`      | Bus events to inbox rows and channels; price alerts (`README.md`, `src/alerts`).                                                                                                                           |
| `svc-support`     | Tickets and knowledge base (`README.md`).                                                                                                                                                                  |
| `svc-market`      | Vendor listings and purchases. Not the price feed (`README.md`).                                                                                                                                           |
| `svc-tax`         | Per-jurisdiction lot export from ledger reads (`README.md`).                                                                                                                                               |
| `svc-quant`       | Paper strategy sandbox; its fills never post to the ledger (`README.md`; its marks in `src/sandbox/book.ts` are fixtures, not a live feed).                                                                |
| `svc-ops`         | Operator CRM, team directory, warehouse revenue; not a money book (`README.md`).                                                                                                                           |
| `svc-mining-pool` | Mining shares and epoch payouts (`src/pplns.ts`, `src/epoch-jobs.ts`). No README.                                                                                                                          |
| `svc-dex`         | Protocol Plane front door: quotes; never posts (`README.md`; `src/quote`).                                                                                                                                 |
| `svc-protocol`    | Non-custodial smart accounts and Solidity under `contracts/`; the venue contract stays `audited: false` (`contracts/venue/SovereignVenue.sol`).                                                            |
| `svc-indexer`     | Chain read models; posts no ledger transaction (`README.md`).                                                                                                                                              |

Compose also runs `migrate` (one-shot, runs every service's migrations: `tooling/infra/migrate-all.mjs`), `litellm`, `academy-minio`, `livekit`, and the two apps.

## Packages that matter

| Package                                     | Role                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ledger-client`                    | The only way a service touches balances (`src/index.ts`). `recipes/` are the reviewable money moves; `money.ts` is scaled bigint; `memory-ledger.ts` is the test reference. `ReadOnlyLedgerClient` has no write method (`src/client.ts`). |
| `packages/contracts`                        | tRPC building blocks and the edge principal check; `scopedProcedure` (`src/trpc.ts`).                                                                                                                                                     |
| `packages/events`                           | The NATS bus and the subject catalog (`src/catalog.ts`); `idempotent` consumer wrapper (`src/bus.ts`).                                                                                                                                    |
| `packages/config`                           | Env loading that fails at boot (`src/env.ts`), feature flags, `checkAccess` jurisdiction matrix (`src/jurisdiction.ts`).                                                                                                                  |
| `packages/auth`                             | Token verification and scopes (imported by `svc-edge`).                                                                                                                                                                                   |
| `packages/exchange-contract`                | The CCXT-shaped public exchange API served to traders (`src/schemas.ts`).                                                                                                                                                                 |
| `packages/venue-contracts`, `venue-adapter` | Sequenced venue book types (`venue-contracts/src/book.ts`); routing across venues (`venue-adapter/src/consolidated-book.ts`).                                                                                                             |
| `packages/db`, `telemetry`, `i18n`, `ui`    | Drizzle helpers, tracing, translations, shared React pieces.                                                                                                                                                                              |

## Money, in one paragraph

A service decides an action is allowed, then calls `svc-ledger` over HTTP through `packages/ledger-client` (`src/http-client.ts`; handler `svc-ledger/src/s2s-http.ts`) with a business key, so a retry finds the original post. For a spot order, `svc-trade` posts `orderHold` before it calls `svc-matching` (`services/svc-trade/src/spot/trade-service.ts`), and a fill posts `tradeFill`. Every post takes `FOR UPDATE` on the single `chain_tip` row (`services/svc-ledger/src/ledger/postgres-ledger.ts`), so posting is one serial line for the whole platform. A scheduled reconciliation proves the book; a failed or throwing proof writes the platform-wide posting freeze (`services/svc-ledger/src/ledger/scheduled-reconcile-tick.ts`, timer at `services/svc-ledger/src/index.ts`). Protocol Plane contracts hold their own state on chain and are not the house book (`services/svc-indexer/README.md`).

## Run it locally

Node 20 or newer and pnpm 10 (`package.json`).

```bash
pnpm install
cp .env.example .env     # then fill in the REQUIRED blocks (see below); until every one is set the stack does not start
pnpm platform:up         # docker compose -f docker-compose.apps.yml up -d --build: infra plus every service and both apps
```

`platform:up` includes `docker-compose.yml` (`docker-compose.apps.yml`), so it starts the infrastructure too (postgres, redis, nats, otel, tempo, prometheus, grafana, two throwaway anvil chains) and needs no `infra:up` first. `pnpm infra:up` (`docker compose up -d`) is infrastructure only, for running tests without the services. Compose refuses to start without `APP_ENV` (`docker-compose.apps.yml`). Host ports: Postgres 5433, Redis 6380, NATS 4222 and 8222, Grafana 3001, Prometheus 9090, Tempo 3200, anvil 8545 and 8546 (`docker-compose.yml`), edge 4000, ws 4014, customer 8090, admin 3100. Tempo and the customer dev server both want 3200.

Boot is blocked until every blank setting in the REQUIRED blocks of `.env.example` has a value (plus two AI-gateway settings that compose reads even though the gateway is optional). They are owner-published, so they are blank on purpose and nothing in the repo supplies them; a blank one makes compose or that service refuse to start. [`docs/SERVICES.md`](SERVICES.md) lists the required settings of every service.

Tests: `pnpm test` is `turbo run test`; most packages use Vitest. Single package: `pnpm --filter @intafaced/<name> test`. Per-service Definition of Done: `pnpm gate`. Broad local check: `pnpm verify`.

## Decisions and runbooks

Settled, hard-to-reverse decisions: [`docs/adr/`](adr/). Operations procedures: [`docs/runbooks/`](runbooks/). Newer ADRs win over older ones. Current truth is `AGENTS.md` and this file, plus `adr/`, `runbooks/`, `refs/` and `agents/`. Everything else under `docs/` is history, not instructions; [`docs/README.md`](README.md) lists what is kept.
