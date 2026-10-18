# Vendor Java money-plane map — D26-P2-02

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Board:** D26-P2-02 · **Generated:** 2026-08-15 · **Tip:** `1723273b`
**Proof runner:** `pnpm map:vendor-java-money-plane` → `tooling/scripts/vendor-java-money-plane-map.mjs`
**Machine proof:** `tooling/vendor-maps/java-money-plane-proof.json`
**Builds on:** [`VENDOR-JAVA-MONEY-PLANE-MAP-2026-08-15.md`](VENDOR-JAVA-MONEY-PLANE-MAP-2026-08-15.md) (tip inventory) · [`VENDOR-JAVA-MONEY-PLANE-MAP-2026-08-09.md`](VENDOR-JAVA-MONEY-PLANE-MAP-2026-08-09.md) (narrative) · ADR [`adr/2026-08-04-java-dual-book-residual.md`](adr/2026-08-04-java-dual-book-residual.md)

**Honesty:** this is a source map. It does **not** claim the Java book is closed or dual-book “fixed.” Compose still runs gitignored jars. SoT for balances is TypeScript `packages/ledger-client` + `svc-ledger`.

## 0 · Counts (executed)

| Metric                       | Count |
| ---------------------------- | ----: |
| Java files (all)             |   897 |
| Java main sources            |   871 |
| Java test sources            |    26 |
| Door apps registered         |   5/5 |
| Wallet RPC spend controllers |     6 |
| Wallet RPC cron spend files  |     4 |

## 1 · Door table — close or §13

| Surface                                                    | Moves value?                    | Control                                                             | Disposition | Proof / socket                                                                                    |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| admin HTTP money controllers                               | source-yes / deploy-no          | DOOR + THROW                                                        | **CLOSED**  | door registration + service throw; no admin compose service                                       |
| ucenter-api HTTP (withdraw/ctc/approve/envelope/promotion) | source-yes / deploy-yes         | DOOR + THROW (Grade C empty — approve/envelope throw at controller) | **CLOSED**  | door fragments include /promotion; compose has ucenter                                            |
| otc-api HTTP                                               | source-yes / boot-no            | DOOR + THROW                                                        | **CLOSED**  | door registered; module documented non-boot                                                       |
| exchange-api /order/add                                    | indirect (settlement in market) | DOOR + THROW in exchange-core                                       | **CLOSED**  | door fragment /order/add + trading-path throws                                                    |
| exchange /monitor settlement publish                       | indirect → market Kafka         | DOOR (fragments /monitor/*)                                         | **CLOSED**  | exchange ApplicationConfig registers door; fragments present                                      |
| market Kafka settlement                                    | yes (if jars run)               | THROW only                                                          | **CLOSED**  | ExchangeTradeConsumer → MemberWalletService throws; unprotectable by HTTP door                    |
| wallet Kafka withdraw → RPC send                           | yes if wallet + RPC deployed    | NONE on chain send; THROW after                                     | **§13**     | FinanceConsumer ordering; compose lacks wallet service · `socket.vendor-wallet-chain-before-book` |
| 01_wallet_rpc HTTP spend                                   | yes (real chain)                | static RPC token perimeter                                          | **§13**     | wallet-rpc-auth-scan + mainnet-scan; dual-book N/A · `socket.wallet-rpc-spend-perimeter`          |
| 01_wallet_rpc @Scheduled spenders                          | yes                             | NONE (floor)                                                        | **§13**     | cron outside HTTP interceptor · `socket.wallet-rpc-spend-perimeter`                               |
| allowlisted second-book writes → ledger recipes            | if throws lifted                | THROW / DOOR / no-op DAO                                            | **§13**     | vendor-java-money allowlist names recipes; zero redirected · `socket.vendor-java-ledger-redirect` |

## 2 · HTTP dual-book door registrations (executed)

- `admin` → REGISTERED · admin:ApplicationConfig.java · interceptor registered on /**
- `ucenter-api` → REGISTERED · ucenter-api:ApplicationConfig.java · interceptor registered on /**
- `otc-api` → REGISTERED · otc-api:ApplicationConfig.java · interceptor registered on /**
- `exchange-api` → REGISTERED · exchange-api:ApplicationConfig.java · interceptor registered on /**
- `exchange` → REGISTERED · exchange:ApplicationConfig.java · interceptor registered on /**

Interceptor fragments include `/promotion`: **true**; `/monitor/*` settlement: **true**.

## 3 · Kafka money surfaces (executed)

- `market.settlement` · market:ExchangeTradeConsumer.java · topics=[exchange-trade, exchange-order-completed, exchange-order-cancel-success] · **THROW** — HTTP door cannot reach Kafka; service throw is the control
- `wallet.finance` · wallet:FinanceConsumer.java · topics=[deposit, withdraw, withdraw-notify] · **§13** — chain send before dual-book throw on withdraw path; module absent from compose today

## 4 · Wallet RPC spend (executed)

### HTTP spend controllers (live send helper)

- `bitcoin:WalletController.java` · **§13** — real on-chain send surface — owner wallet-rpc perimeter / auth (not dual-book door)
- `ect:WalletController.java` · **§13** — real on-chain send surface — owner wallet-rpc perimeter / auth (not dual-book door)
- `erc-eusdt:WalletController.java` · **§13** — real on-chain send surface — owner wallet-rpc perimeter / auth (not dual-book door)
- `erc-token:WalletController.java` · **§13** — real on-chain send surface — owner wallet-rpc perimeter / auth (not dual-book door)
- `eth:WalletController.java` · **§13** — real on-chain send surface — owner wallet-rpc perimeter / auth (not dual-book door)
- `usdt:WalletController.java` · **§13** — real on-chain send surface — owner wallet-rpc perimeter / auth (not dual-book door)

### Stub / non-spend controllers (CLOSED)

- `bch:WalletController.java` · **CLOSED** — stub route only — no chain send helper in controller
- `bsv:WalletController.java` · **CLOSED** — stub route only — no chain send helper in controller
- `btm:WalletController.java` · **CLOSED** — stub route only — no chain send helper in controller
- `ltc:WalletController.java` · **CLOSED** — stub route only — no chain send helper in controller

### Cron / floor spenders

- `erc-eusdt:CoinCollectJob.java` · **§13** — @Scheduled spender — HTTP interceptor cannot cover
- `erc-token:CoinCollectJob.java` · **§13** — @Scheduled spender — HTTP interceptor cannot cover
- `eth-support:PaymentHandler.java` · **§13** — @Scheduled spender — HTTP interceptor cannot cover
- `usdt:CoinCollectJob.java` · **§13** — @Scheduled spender — HTTP interceptor cannot cover

## 5 · Brand / custody — real posture (executed)

| Check                                                  | Result                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `brand-scan` skips `vendor/`                           | true                                                                                                                                                                                             |
| `shell-brand-scan` present (product surface)           | true                                                                                                                                                                                             |
| `custody-scan` check 3 opens Java runtime risk modules | true                                                                                                                                                                                             |
| Java money gate                                        | `tooling/ci/vendor-java-money-scan.mjs`                                                                                                                                                          |
| Door gate                                              | `tooling/ci/dual-book-door-scan.mjs`                                                                                                                                                             |
| Verdict                                                | REAL — brand product surface via shell-brand-scan; dual-book via vendor-java-money + door gates; custody-scan check 3 opens framework money-plane runtime surface (not wallet_rpc spend daemons) |

## 6 · §13 sockets named by this map

| Socket                                   | Why it is not agent-closeable                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `socket.vendor-wallet-chain-before-book` | Withdraw path can hit RPC send before dual-book throw; needs owner control before compose ever mounts `wallet` |
| `socket.wallet-rpc-spend-perimeter`      | Real chain spend + cron floor; security review / Class X — not dual-book door work                             |
| `socket.vendor-java-ledger-redirect`     | Allowlisted second-book sites name ledger recipes; zero redirected yet (ADR residual)                          |

## 7 · How to re-prove

```bash
pnpm map:vendor-java-money-plane --self-test
pnpm scan:dual-book-door
pnpm scan:vendor-java-money
pnpm scan:wallet-rpc-auth
pnpm scan:custody   # Protocol Plane only — expected
pnpm scan:shell-brand
```
