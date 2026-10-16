# Architecture

Checked 2026-10-16 against commit `425647517` (`fix(pay): close founder destination reveal… (#4809)`). This branch was cut from local `origin/main` with `GIT_NO_LAZY_FETCH=1`. No container was started. "Served" means the compose file names that Dockerfile.

Agent rules: [`AGENTS.md`](../AGENTS.md).

## What this tree is

|                          | Count           | How it was counted                                                                                                                                         |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apps                     | 4               | directories under `apps/`: `admin`, `customer`, `invitation`, `mobile`                                                                                     |
| Service directories      | 26              | directories under `services/`                                                                                                                              |
| Compose `svc-*` services | 25              | keys in `docker-compose.apps.yml`. `svc-matching-rust-stage1` is the directory that is not a compose service                                               |
| Packages                 | 23              | directories under `packages/`                                                                                                                              |
| Compose file             | 31 service keys | includes `migrate`, `litellm`, `academy-minio`, `livekit`, `vendor-shell`, `admin`, plus the 25 `svc-*` services. `include:` pulls in `docker-compose.yml` |

`apps/web`, `services/svc-chain`, `services/svc-launch`, and `services/svc-core-ops` are not directories on this commit. The July law's layout tree (`INTAFACED_DEFINITIVE_BUILD.md` §2) still names them. That section loses to this file.

## Apps

| App               | What it is                                                                                                    | How it runs                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/customer`   | React 19 and Vite (`apps/customer/package.json:24`, `:35`). Sole customer site (`apps/customer/Dockerfile:1`) | Compose service `vendor-shell` builds that Dockerfile and publishes `8090:80` (`docker-compose.apps.yml:1777`, `:1780`, `:1789`). Dev server: `pnpm --filter @intafaced/customer dev` on port 3200 (`apps/customer/package.json:6`) |
| `apps/admin`      | Next 15 operator console (`apps/admin/package.json:8`, `:23`)                                                 | Compose publishes `3100:3100` (`docker-compose.apps.yml:1908`). Dev server uses the same port (`apps/admin/package.json:7`)                                                                                                         |
| `apps/invitation` | React and Vite join questionnaire (`apps/invitation/package.json:7`, `:19`)                                   | Not a compose HTTP process. The compose comment says the separate join project builds this app (`docker-compose.apps.yml:1744`)                                                                                                     |
| `apps/mobile`     | Capacitor wrapper of the React customer site (`apps/mobile/package.json:6`)                                   | `apps/mobile/scripts/build-wrap.mjs:3` stages that site. Not a fleet HTTP service (`docker-compose.apps.yml:1755` still says "Vue shell"; the package and the script are the current text)                                          |

The customer shell is one signed-in frame (`apps/customer/src/app/Shell.tsx:9`). Hidden features are rows in `apps/customer/src/app/feature-registry.ts`. nginx serves the built files, falls deep links through to `index.html` (`apps/customer/nginx.conf:41`), proxies `/api/` to `svc-edge:4000` (`:47`), and proxies `/ws/` to `svc-ws:4014/` (`:59`).

`vendor/upstream-exchange/05_Web_Front` is retained and not served (`docker-compose.apps.yml:1741`). `vendor/upstream-exchange/04_Web_Admin` is not served (`docker-compose.apps.yml:1809`). The staff surface that is served is `admin`.

## Money

1. A service posts a balance only through `packages/ledger-client`. The package header says it is the only way any service touches balances (`packages/ledger-client/src/index.ts:2`). Recipes live in `packages/ledger-client/src/recipes`.
2. `PostgresLedger` implements `LedgerClient` (`services/svc-ledger/src/ledger/postgres-ledger.ts:63`).
3. `MemberWalletService.increaseBalance` throws. The only `MemberWalletService.java` in the tree sits under `vendor/upstream-exchange/00_framework/core`, and the throw is line 310 of that file. `AGENTS.md` money rule 4 names the same class. The Java package directory is the upstream group id; this map does not spell it, because the brand scan rejects that name in this file.
4. The customer package depends on `@intafaced/ledger-client` (`apps/customer/package.json:19`). This pass did not trace whether the UI uses it to format amounts or to post.

A spot order is allowed and funded in `services/svc-trade` (`services/svc-trade/README.md:5`: "it does not match orders and it does not hold balances"). Matching is `services/svc-matching` (`services/svc-matching/README.md:3`: "Orderbooks and matching. Nothing else."). `svc-trade` talks to the engine over HTTP (`services/svc-trade/src/spot/matching-client.ts:7`: "svc-matching is a separate service"). The fill becomes money when the ledger posts.

Order words live in `packages/exchange-contract/src/schemas.ts` (the file is present; its header describes the public exchange shape, `packages/exchange-contract/src/schemas.ts:4`).

## Doors

`svc-edge` turns a bearer token into the signed principal (`services/svc-edge/README.md:3`). Host port `4000` (`docker-compose.apps.yml:305`). The route table in that README is the edge's own contract; this pass did not re-walk every prefix.

`svc-ws` is the live public market-data stream (`services/svc-ws/README.md:3`). Host port `4014` (`docker-compose.apps.yml:796`). It is not `svc-market`. `svc-market` is vendor listings (`services/svc-market/README.md:3`: "Vendor lifecycle for `market.vendors`").

Other `svc-*` processes are on the compose network. This pass found host `ports:` on the apps file only for edge `4000`, ws `4014`, the customer site `8090`, and admin `3100`.

## Name traps

| Folder                                                      | Job                                                                                      | Easy to confuse with                                                                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/customer`                                             | Served customer screen                                                                   | `vendor/upstream-exchange/05_Web_Front` (not served)                                                                                                               |
| `svc-matching/src/engine`                                   | House order book                                                                         | `svc-matching-rust-stage1` (socket; TypeScript engine stays the default, `src/lib.rs:4`); `SovereignVenue.sol` (protocol book, `audited` stays false, file line 9) |
| `svc-blueprint/src/matching/crew-matching.ts`               | Crew pairing (`crew-matching.ts:5`, "CREW MATCHING")                                     | The order engine                                                                                                                                                   |
| `svc-market`                                                | Vendor shop                                                                              | The price feed (`svc-ws`)                                                                                                                                          |
| `svc-quant/src/sandbox/book.ts`                             | Paper book. `BTC-USD` is fixed at `50000` (`book.ts:4`, "Not a live feed")               | A live mark                                                                                                                                                        |
| `svc-execution`                                             | Partial OMS. It does not own the whole order life (`services/svc-execution/README.md:5`) | `svc-trade`                                                                                                                                                        |
| `svc-protocol` contracts for passkey, lending, escrow, card | Chain plane                                                                              | Login, fiat loans, P2P escrow, fiat cards                                                                                                                          |
| `svc-bank`                                                  | Fiat accounts over the ledger. "no new balance system" (`services/svc-bank/README.md:5`) | Chain lending and chain vaults                                                                                                                                     |
| `svc-pay`                                                   | Merchant payments into the ledger (`services/svc-pay/README.md:3`)                       | P2P ads (`svc-p2p`) and chain accept                                                                                                                               |
| `svc-p2p`                                                   | Ledger-backed escrow. "it does not hold balances" (`services/svc-p2p/README.md:7`)       | `SovereignEscrow.sol`                                                                                                                                              |
| `svc-dex`                                                   | Protocol front door. "This process never posts" (`services/svc-dex/README.md:5`)         | The house book                                                                                                                                                     |
| `svc-indexer`                                               | Chain read model. "posts no ledger transaction" (`services/svc-indexer/README.md:7`)     | The house book                                                                                                                                                     |

## One module per capability

Extend the path in this table. Each path was confirmed to exist on this commit on 2026-10-16, except the two rows marked absent. Do not invent `svc-bridge` or an INTACORE package to fill those rows.

| Capability               | Extend this path                                                    | On this commit |
| ------------------------ | ------------------------------------------------------------------- | -------------- |
| `ledger-recipes`         | `packages/ledger-client/src/recipes`                                | exists         |
| `ledger-store`           | `services/svc-ledger/src/ledger/postgres-ledger.ts`                 | exists         |
| `balance-read`           | `services/svc-ledger/src/router.ts`                                 | exists         |
| `account-freeze`         | `services/svc-ledger/src/ledger`                                    | exists         |
| `order-matching`         | `services/svc-matching/src/engine`                                  | exists         |
| `order-lifecycle`        | `services/svc-trade/src/spot`                                       | exists         |
| `matching-client`        | `services/svc-trade/src/spot/matching-client.ts`                    | exists         |
| `order-types-tif`        | `packages/exchange-contract/src/schemas.ts`                         | exists         |
| `trade-fees`             | `services/svc-trade/src/spot/fee-schedule.ts`                       | exists         |
| `market-data-stream`     | `services/svc-ws`                                                   | exists         |
| `sequenced-venue-book`   | `packages/venue-contracts/src/book.ts`                              | exists         |
| `fix-gateway`            | `services/svc-fix`                                                  | exists         |
| `sbe-codec`              | `packages/sbe-codec`                                                | exists         |
| `algo-orders`            | `services/svc-trade/src/algo`                                       | exists         |
| `futures-liquidation`    | `services/svc-trade/src/futures`                                    | exists         |
| `options-greeks`         | `packages/greeks-adapter`                                           | exists         |
| `otc-desk`               | `services/svc-trade/src/otc`                                        | exists         |
| `convert`                | `services/svc-trade/src/convert`                                    | exists         |
| `copy-trading`           | `services/svc-trade/src/copy`                                       | exists         |
| `trading-controls`       | `services/svc-trade/src/controls`                                   | exists         |
| `external-execution`     | `services/svc-execution`                                            | exists         |
| `rank-discount`          | `services/svc-identity/src/rank`                                    | exists         |
| `earn`                   | `services/svc-bank/src/earn`                                        | exists         |
| `loans-fiat`             | `services/svc-bank/src/loans`                                       | exists         |
| `cards-fiat`             | `services/svc-bank/src/cards`                                       | exists         |
| `fiat-ramps`             | `services/svc-bank/src/ramps`                                       | exists         |
| `bank-transfers`         | `services/svc-bank/src/transfers`                                   | exists         |
| `merchant-payments`      | `services/svc-pay`                                                  | exists         |
| `payment-rails`          | `services/svc-pay/src/rails`                                        | exists         |
| `subscriptions`          | `services/svc-pay/src/subscription-router.ts`                       | exists         |
| `kyb`                    | `services/svc-pay/src/kyb-router.ts`                                | exists         |
| `pay-fraud`              | `services/svc-pay/src/fraud`                                        | exists         |
| `p2p-escrow`             | `services/svc-p2p`                                                  | exists         |
| `p2p-merchant-programme` | `services/svc-p2p/src/merchant-service.ts`                          | exists         |
| `auth-sessions`          | `services/svc-identity/src/auth`                                    | exists         |
| `passkeys-login`         | `services/svc-identity/src/enroll-passkey-router.ts`                | exists         |
| `api-keys`               | `services/svc-identity/src`                                         | exists         |
| `kyc`                    | `services/svc-identity/src/kyc`                                     | exists         |
| `affiliates`             | `services/svc-identity/src`                                         | exists         |
| `edge-principal`         | `services/svc-edge`                                                 | exists         |
| `notifications`          | `services/svc-notify`                                               | exists         |
| `price-alerts`           | `services/svc-notify/src/alerts`                                    | exists         |
| `agents-fleet`           | `services/svc-agents`                                               | exists         |
| `agent-metering`         | `services/svc-agents/src/metering`                                  | exists         |
| `academy`                | `services/svc-academy`                                              | exists         |
| `blueprint-profile`      | `services/svc-blueprint`                                            | exists         |
| `marketplace`            | `services/svc-market`                                               | exists         |
| `quant-sandbox`          | `services/svc-quant`                                                | exists         |
| `support-desk`           | `services/svc-support`                                              | exists         |
| `tax-lots`               | `services/svc-tax`                                                  | exists         |
| `ops-crm`                | `services/svc-ops`                                                  | exists         |
| `ifc-stake`              | `services/svc-token`                                                | exists         |
| `dex-quotes`             | `services/svc-dex/src/quote`                                        | exists         |
| `chain-indexer`          | `services/svc-indexer`                                              | exists         |
| `smart-accounts`         | `services/svc-protocol/src/accounts`                                | exists         |
| `protocol-amm`           | `services/svc-protocol/contracts/amm`                               | exists         |
| `protocol-clob`          | `services/svc-protocol/contracts/venue/SovereignVenue.sol`          | exists         |
| `protocol-escrow`        | `services/svc-protocol/contracts/escrow/SovereignEscrow.sol`        | exists         |
| `protocol-lending`       | `services/svc-protocol/contracts/lending/IsolatedLendingMarket.sol` | exists         |
| `protocol-oracle`        | `services/svc-protocol/contracts/oracle/FailClosedOracle.sol`       | exists         |
| `mining-pool`            | `services/svc-mining-pool`                                          | exists         |
| `wallet-rpc`             | `vendor/upstream-exchange/01_wallet_rpc`                            | exists         |
| `customer-ui`            | `apps/customer`                                                     | exists         |
| `admin-ui`               | `apps/admin`                                                        | exists         |
| `invitation`             | `apps/invitation`                                                   | exists         |
| `mobile-wrap`            | `apps/mobile`                                                       | exists         |
| `i18n`                   | `packages/i18n`                                                     | exists         |
| `events-bus`             | `packages/events`                                                   | exists         |
| `shared-auth-lib`        | `packages/auth`                                                     | exists         |
| `chain-bridge`           | `(none on main)`                                                    | absent         |
| `intacore-matcher`       | `(none on main)`                                                    | absent         |

## Services

Every directory under `services/` is listed. The one-line job is quoted only where this pass opened the README. `svc-fix` and `svc-mining-pool` have no `README.md`.

| Directory                  | Compose           | Job confirmed this pass                                                               |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `svc-academy`              | yes               | directory present; open its README before editing                                     |
| `svc-agents`               | yes               | directory present; open its README before editing                                     |
| `svc-bank`                 | yes               | Multi-currency accounts over the ledger (`README.md:3`)                               |
| `svc-blueprint`            | yes               | directory present; crew pairing is `src/matching/crew-matching.ts`                    |
| `svc-dex`                  | yes               | Protocol front door; never posts (`README.md:5`)                                      |
| `svc-edge`                 | yes, host `:4000` | Signed principal (`README.md:3`)                                                      |
| `svc-execution`            | yes               | Partial OMS, not the order store (`README.md:5`)                                      |
| `svc-fix`                  | yes               | Java FIX gateway (`pom.xml`, `src/test/java/io/intafaced/fix/`). No README            |
| `svc-identity`             | yes               | directory present; open its README before editing                                     |
| `svc-indexer`              | yes               | Chain read model; posts no ledger transaction (`README.md:7`)                         |
| `svc-ledger`               | yes               | Postgres ledger store (`src/ledger/postgres-ledger.ts:63`)                            |
| `svc-market`               | yes               | Vendor listings, not the price feed                                                   |
| `svc-matching`             | yes               | House matcher (`README.md:3`)                                                         |
| `svc-matching-rust-stage1` | no                | Socket. TypeScript engine stays the default (`src/lib.rs:4`). `Cargo.toml` is present |
| `svc-mining-pool`          | yes               | directory present. No README                                                          |
| `svc-notify`               | yes               | directory present; open its README before editing                                     |
| `svc-ops`                  | yes               | directory present; open its README before editing                                     |
| `svc-p2p`                  | yes               | Ledger-backed P2P escrow (`README.md:7`)                                              |
| `svc-pay`                  | yes               | Payments core (`README.md:3`)                                                         |
| `svc-protocol`             | yes               | Chain contracts under `contracts/`                                                    |
| `svc-quant`                | yes               | Paper sandbox; fills never post (`README.md:4`)                                       |
| `svc-support`              | yes               | directory present; open its README before editing                                     |
| `svc-tax`                  | yes               | directory present; open its README before editing                                     |
| `svc-token`                | yes               | directory present; open its README before editing                                     |
| `svc-trade`                | yes               | Spot order life (`README.md:5`)                                                       |
| `svc-ws`                   | yes, host `:4014` | Public market-data stream (`README.md:3`)                                             |

`litellm`, `livekit`, and `academy-minio` are compose sidecars next to agents and academy. This pass did not open their configs beyond seeing the service keys.

## Run it locally

From a checkout, with pnpm 10 (`package.json` `packageManager`) and Node 20 or newer (`package.json` `engines`):

```bash
pnpm install
cp .env.example .env
pnpm infra:up        # docker compose up -d  (postgres, redis, nats, observability)
pnpm platform:up     # docker compose -f docker-compose.apps.yml up -d --build
```

`platform:up` includes `docker-compose.yml` (`docker-compose.apps.yml:24`), so it starts infrastructure and the application together. `infra:up` is the database, bus, and observability only (`package.json` scripts `infra:up` and `platform:up`).

Compose refuses to start if `EDGE_PRINCIPAL_SECRET` or `INTERNAL_SERVICE_SECRET` is unset (`docker-compose.apps.yml:84`, `:87`), and if `APP_ENV` is unset (`:65`). Copy `.env.example` and read its header before the first `platform:up`.

Host ports this pass read:

| Port       | Process                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| 5433       | Postgres (container 5432). Default `POSTGRES_HOST_PORT` (`docker-compose.yml:26`)                              |
| 6380       | Redis (`docker-compose.yml:43`)                                                                                |
| 4222, 8222 | NATS client and monitor (`docker-compose.yml:63`)                                                              |
| 3001       | Grafana (`docker-compose.yml:269`)                                                                             |
| 9090       | Prometheus (`docker-compose.yml:110`)                                                                          |
| 3200       | Tempo (`docker-compose.yml:96`). The customer Vite dev server also wants 3200 (`apps/customer/package.json:6`) |
| 4000       | `svc-edge`                                                                                                     |
| 4014       | `svc-ws`                                                                                                       |
| 8090       | Customer site (nginx in the `vendor-shell` container)                                                          |
| 3100       | Admin, both the compose mapping and `next dev`                                                                 |

`docs/RUNNING.md` opens with a correction banner (2026-10-16). This change replaced the old opening. Stale counts remain under that banner, including the "Twenty-one containers" check. The commands `pnpm platform:up` and `pnpm infra:up` match `package.json`.

A customer dev server on port 3200 does not use `apps/customer/nginx.conf`. The same-origin `/api` and `/ws` proxies exist on the compose site at `:8090`.

## Tests

Root `pnpm test` is `turbo run test` (`package.json`). Most packages use Vitest (`services/svc-ledger/package.json:12` is the pattern). `svc-fix` runs Maven and then Vitest (`services/svc-fix/package.json:18`). Playwright entry points are the `ui:proof*` scripts in the root `package.json`.

On 2026-10-16 a filename count of `*.test.*`, `*.spec.*`, and `*Test.java` under `apps`, `services`, `packages`, and `tooling`, skipping `node_modules`, `dist`, and `vendor`, found 2,517 files. Largest suites: `svc-trade` 316, `svc-execution` 232, `svc-pay` 161, `svc-identity` 157, `apps/customer` 77, `apps/admin` 72. `svc-fix` had 12. This count is files, not passing tests. Nothing was executed.

CI workflows in `.github/workflows/`: `ci.yml`, `docs-format.yml`, `gate-file-guard.yml`, `gitleaks.yml`, `order-path-cx8.yml`, `staging-deploy.yml`, `supply-chain.yml`, `vendor-compile.yml`, `venue-aggregation-live-network.yml`. Docs-only pull requests run Prettier in `docs-format.yml`. `INTAFACED_DEFINITIVE_BUILD.md` and agent-rule files are not docs-only (`tooling/scripts/merge-gate.mjs` `CI_PR_PATHS`).

## Docs that disagree with this tree

These files are still in place because something in the repo references them, or because a later section of the same file is still true. Do not follow the stale sentence. The correction is at the top of each file, except the compose file and `package.json`, which this change does not edit.

| File                                                         | Stale sentence                                                                                                 | Why it stayed                                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INTAFACED_DEFINITIVE_BUILD.md` §1 and §2                    | §1 still says Next.js for every surface; §2 still names `apps/web`, `ws-gateway`, `svc-launch`, `svc-core-ops` | Coverage gate, `ci.yml`, and `package.json` name the file. §5.3 is rewritten in this change (`INTAFACED_DEFINITIVE_BUILD.md` "The product shell"): React `apps/customer` on `:8090`. It is not a stale Vue section |
| `docs/adr/2026-08-03-retire-apps-web-port-to-vue-shell.md`   | Vue shell is the sole product surface                                                                          | Tracker and the July law cite it                                                                                                                                                                                   |
| `docs/adr/2026-08-15-java-vs-ts-money-sot-seal.md` §2 UI row | Vue shell is the sole product UI                                                                               | The money seal in the same file still matches `ledger-client` and the Java throw                                                                                                                                   |
| `docs/RUNNING.md`                                            | "Twenty-one containers" health check under the correction banner                                               | `README.md`, `.env.example`, and `services/svc-blueprint/src/readiness.ts` cite it. The old opening count is replaced; the banner names it                                                                         |
| `docker-compose.apps.yml:1` and `:1755` and `:1765`          | "eleven services"; mobile is a Vue wrap; `apps/web` is still on disk                                           | Compose file. Not edited                                                                                                                                                                                           |
| `package.json` description                                   | "Law: INTAFACED_DEFINITIVE_BUILD.md"                                                                           | Package manifest. Not edited                                                                                                                                                                                       |
| `services/svc-ws/README.md`                                  | Browser path used to name the Vue nginx                                                                        | Corrected in this change to `apps/customer/nginx.conf`                                                                                                                                                             |
| `services/svc-indexer/README.md`                             | Opening line used to name `apps/web`                                                                           | Corrected in this change. "posts no ledger transaction" is `README.md:7`                                                                                                                                           |
