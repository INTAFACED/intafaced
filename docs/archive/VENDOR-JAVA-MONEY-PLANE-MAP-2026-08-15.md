# Vendor Java money-plane map — tip inventory (2026-08-15)

**Tracker:** D26-P2-02 · **Lane:** `denon-d26-p2-02-java-map` · **Class N map-only**  
**Tip:** `1723273b` (`origin/main`) · **Tree:** `vendor/upstream-exchange/`  
**Does not claim:** dual-book “fixed,” Java runtime safety from a source scan, or wallet-RPC go-live.  
**Builds on:** ADR [`adr/2026-08-04-java-dual-book-residual.md`](adr/2026-08-04-java-dual-book-residual.md) (D-S-17) · historical narrative [`VENDOR-JAVA-MONEY-PLANE-MAP-2026-08-09.md`](VENDOR-JAVA-MONEY-PLANE-MAP-2026-08-09.md) · generator land #1751 [`VENDOR-JAVA-MONEY-PLANE-MAP-D26-P2-02.md`](VENDOR-JAVA-MONEY-PLANE-MAP-D26-P2-02.md).  
**Leverage:** Phase A IN — existing dual-book ADR + `vendor-java-money-scan` / door / wallet-rpc scans. No second book, no Vue craft.

Re-prove: `pnpm map:vendor-java-money-plane --self-test` · `pnpm scan:vendor-java-money` · `pnpm scan:dual-book-door` · `pnpm scan:wallet-rpc-auth` · `pnpm scan:wallet-rpc-mainnet`.

---

## 0 · What is source of truth

| Plane                         | SoT today                                                                                    | Java’s role                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Customer / house balances     | TypeScript `packages/ledger-client` recipes + `svc-ledger`                                   | `member_wallet` is a **read-only projection**. Zero allowlisted sites redirect. |
| Spot/OTC/CTC second-book hits | Frozen in **source** (DAO no-op + service throw + 410 door). **Not** proved of compose jars. | Work queue, not a closed book.                                                  |
| On-chain sends                | Wallet RPC daemons (`01_wallet_rpc`) if they ever boot                                       | Dual-book apparatus does **not** apply. Owner / Class X perimeter.              |

ADR 2026-08-04 stands: a green `vendor-java-money-scan` is a statement about scanned source. Compose runs gitignored `<module>/target/<module>.jar`. **Do not cite the scan as runtime proof.**

---

## 1 · Executed counts (this tip)

| Metric                                                                       | This tip                                                                              | #1751 / 2026-08-13 map                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| Java files walked by money scan                                              | **871** main + **26** tests skipped                                                   | 871 main / 897 all                           |
| Dual-book ratchet                                                            | **54** known writes across **20** files                                               | same generator; Grade C prose was stale      |
| DAO `@Query` no-ops proved (check 2, all `member_wallet` UPDATEs on the DAO) | **14** declarations                                                                   | 4-name hole closed after 2026-08-09 map §6.2 |
| HTTP door apps registered                                                    | **5/5** (`admin`, `ucenter-api`, `otc-api`, `exchange-api`, **`exchange`**)           | 5/5 (exchange door landed after 2026-08-09)  |
| Grade C (door-only entity mutation)                                          | **empty** — `ApproveController` / `RedEnvelopeController` throw                       | map still said “door-only”                   |
| Grade D (held by nothing)                                                    | **empty** (ratcheted; no mass-delete this PR)                                         | empty since P2-07                            |
| Wallet RPC HTTP spend controllers                                            | **6** (`bitcoin`, `ect`, `usdt`, `eth`, `erc-token`, `erc-eusdt`)                     | 6                                            |
| Wallet RPC cron spend files                                                  | **4** (usdt collect, erc-token collect, erc-eusdt collect, eth-support payment queue) | **2** (heuristic miss)                       |
| `act` auth                                                                   | **RECORDED UNPROVEN** (F10; sibling lane)                                             | same                                         |

`vendor-java-money-scan` extra line on this tip: _SOURCE ONLY — not jar/runtime proof_.

---

## 2 · Door table — close or §13

**Door count: 10 surfaces** in this table. **Still-live chain value paths: 11** (6 HTTP RPC + 4 cron + 1 wallet Kafka send-before-book). Dual-book HTTP/Kafka **book** writes are source-frozen, not chain-frozen.

| #   | Surface                                                      | Can move value?                | Control                                                                    | Disposition | Notes                                                                               |
| --- | ------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| 1   | `admin` HTTP money controllers                               | source-yes / **no compose**    | 410 door + service throw                                                   | **CLOSED**  | Door never executed in deploy; jobs `@Scheduled` held by throw only                 |
| 2   | `ucenter-api` HTTP (withdraw/ctc/approve/envelope/promotion) | source-yes / **in compose**    | 410 door **and** throw (incl. former Grade C)                              | **CLOSED**  | `/promotion` fragment present; compose runs ucenter                                 |
| 3   | `otc-api` HTTP                                               | source-yes / **cannot boot**   | door + throw                                                               | **CLOSED**  | In compose; documented non-boot; do not vendor a jar to make it boot                |
| 4   | `exchange-api` `/order/add`                                  | indirect → market Kafka        | door + `exchange-core` throw                                               | **CLOSED**  | Settlement is not in this module                                                    |
| 5   | `exchange` `/monitor` settlement publish                     | indirect → market Kafka        | **door now registered** (`/monitor/reset-trader`, `/monitor/start-trader`) | **CLOSED**  | 2026-08-09 #1 candidate; landed in source                                           |
| 6   | `market` Kafka settlement                                    | yes **if jars run**            | **throw only** (HTTP door cannot reach Kafka)                              | **CLOSED**  | Largest deployed second-book seam; still one mechanism                              |
| 7   | `wallet` Kafka withdraw → RPC HTTP send                      | yes if wallet **and** RPC boot | **none on chain send**; throw **after**                                    | **§13**     | `socket.vendor-wallet-chain-before-book` · no compose `wallet` service today        |
| 8   | `01_wallet_rpc` HTTP spend (6 controllers)                   | **yes — real chain**           | static RPC token on HTTP `/**`                                             | **§13**     | `socket.wallet-rpc-spend-perimeter` · GET query params · one token = full withdraw  |
| 9   | `01_wallet_rpc` `@Scheduled` spenders (4 files)              | **yes — floor**                | **none** (interceptor irrelevant)                                          | **§13**     | same socket · miner-fee / gas top-up / payment queue                                |
| 10  | Allowlisted second-book writes → ledger recipes              | if throws lifted               | throw / door / DAO no-op                                                   | **§13**     | `socket.vendor-java-ledger-redirect` · **zero** of 54 redirected to `ledger-client` |

No Grade D mass-delete in this PR. Empty Grade D is already law (P2-07); this map does not reopen it.

---

## 3 · Top 3 still-live value paths

These are the paths that can still move **real value** (chain), not Hibernate `member_wallet` rows.

1. **Wallet RPC HTTP withdraw / transfer / sweep** on six modules (`bitcoin`, `ect`, `usdt`, `eth`, `erc-token`, `erc-eusdt`). Mass-sweep `/rpc/transfer` and caller-named `/rpc/transfer-from-address` remain. Stubs (`bch`, `bsv`, `btm`, `ltc`) map routes but do not send. `eos` / `xmr` / `act` have no send path (`act` = F10 proof gap, small value).
2. **Wallet RPC cron floor spenders (4):** `usdt:CoinCollectJob` (2h miner-fee top-up via `sendTransaction`); `erc-token` + `erc-eusdt` `CoinCollectJob` (`transferFromWithdrawWallet` gas top-ups); `eth-support:PaymentHandler.doJob` (every 30s payment queue). `eth:CoinCollectJob` is **balance sync only** — not a spender.
3. **`wallet:FinanceConsumer` withdraw listener:** interpolates `SERVICE-RPC-{COIN}` and `GET /rpc/withdraw` **before** `withdrawSuccess` throw; catch swallows into “manual.” Dual-book never sees the send. Today the module is **absent from compose** — deployment absence, not a control. Mounting `wallet` without a pre-send kill is a double-payout shape.

`market` Kafka settlement is the largest **second-book** seam still deployed, but it terminates in `MemberWalletService` throws in **source**. It is CLOSED for the book, unverified for stale jars.

---

## 4 · Brand / custody — real (not theater)

| Gate                      | What it actually covers                                                                                                                                                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brand-scan`              | Repo docs/product copy; skips `vendor/` identity tokens; **does** walk vendor **product-surface** (D26-P2-14). This doc uses `module:Class` keys.                                                                                                                                                                                 |
| `shell-brand-scan`        | Vue product shell.                                                                                                                                                                                                                                                                                                                |
| `vendor-java-money-scan`  | Dual-book SQL + DAO no-op integrity + mutator/setter ratchet. Successor to “custody-scan reads Java” for **the book**.                                                                                                                                                                                                            |
| `dual-book-door-scan`     | Interceptor **registration** on five apps, not merely the import.                                                                                                                                                                                                                                                                 |
| `custody-scan`            | Checks 1–2 = Protocol Plane non-custody. **Check 3 (D26-P2-08 #1748)** opens framework runtime-risk modules: `admin`, `ucenter-api`, `otc-api`, `exchange-api`, `market`, `wallet`, `exchange`, `core`. **Does not** walk `01_wallet_rpc` spend daemons. Dual-book ratchet stays in `vendor-java-money-scan` (ADR standing rule). |
| `wallet-rpc-auth-scan`    | 12/13 prove perimeter at reactor version; `act` UNPROVEN.                                                                                                                                                                                                                                                                         |
| `wallet-rpc-mainnet-scan` | Frozen constants + barriers: **none** of the scanned Dockerfiles/compose/workflows builds or boots `01_wallet_rpc`.                                                                                                                                                                                                               |

Verdict: brand and dual-book **gates are real**. Custody check 3 is real for the **framework** money-plane, **silent on the chain daemons** that actually send. That split is why rows 8–9 stay §13 / Class X, not “scan green ⇒ safe to run.”

Do not paste secrets, keystore hex, or RPC tokens from `application.properties`. Mainnet literals stay in the frozen scan; they are not reproduced here.

---

## 5 · §13 sockets (not agent-closeable)

| Socket                                   | Why it stays a socket                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `socket.vendor-wallet-chain-before-book` | Chain send precedes dual-book throw; owner control required before compose ever mounts `wallet`. |
| `socket.wallet-rpc-spend-perimeter`      | Real chain HTTP + cron floor; security review / Class X. F10 `act` is a sibling, not this map.   |
| `socket.vendor-java-ledger-redirect`     | 54 ratcheted sites name recipes; **none** implemented. A throw is a holding position (ADR).      |

TS-ledger SoT does **not** make these sockets “done.” Redirecting Java mutators is D26-P2-07 residual / recipe queue, not this PR.

---

## 6 · What this PR does not do

- No Grade D mass-delete (already empty; not reopened).
- No Dependabot Maven edits.
- No P3-02 threat-model, owner wallet-rpc secrets packet, `owner-ruling-packet.json`, skip-scan CI, `svc-matching`, `svc-academy`, or `packages/config` screening.
- No Shehzad protocol/chain. No Vue.
- No claim that compose jars match this source.

---

## 7 · Coverage of this refresh

**Re-run this tip:** money scan, door scan, wallet-rpc auth + mainnet.  
**Re-read:** `FinanceConsumer` withdraw ordering; `ApproveController` / `RedEnvelopeController` throws; five `ApplicationConfig` door registrations; interceptor `/promotion` + `/monitor/*`; four cron send calls; six spend controllers vs four stubs.  
**Not re-booted:** vendor jars, wallet RPC processes, Kafka.  
**Generator:** `tooling/scripts/vendor-java-money-plane-map.mjs` cron heuristic widened so the four floor spenders count; Grade C prose corrected.
