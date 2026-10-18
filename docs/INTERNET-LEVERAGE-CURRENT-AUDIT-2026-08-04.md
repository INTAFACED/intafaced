# Internet leverage — Phase A current audit (in-repo)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Superseded for exchange OSS (2026-08-31):** named take/keep/never is [`BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md`](BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md) + north-star §0.3. This file remains the Phase A **in-repo asset register**. Do **not** treat “FIX not found” or “binary feeds not found” as a ban on QuickFIX/J or Real Logic SBE **adapters**.

**Status:** PHASE A PROPER · **finished for NOW residual craft** · enforced via [`INTERNET-LEVERAGE-LAW.md`](INTERNET-LEVERAGE-LAW.md) (agents · CI auto-load)  
**Original execute:** 2026-08-04 · **Refresh tip:** re-derive `origin/main` at refresh  
**Plan law:** harvest `INTERNET-LEVERAGE-CURRENT-AUDIT-PLAN-2026-08-04.md` §8  
**Methodology audit:** [`INTERNET-LEVERAGE-METHODOLOGY-AUDIT-2026-08-05.md`](INTERNET-LEVERAGE-METHODOLOGY-AUDIT-2026-08-05.md)  
**Term:** Internet leverage = already-built code/systems we adopt, wire, or wrap instead of rebuilding.

**Lanes:** Nitro + Denon. **Shehzad:** cross-plane only (bridge / dual-target matching).

**Refresh reasons (tip drift):** `apps/web` deleted (#757) · vendor path `vendor/upstream-exchange` (#771) · depth client #748 · open PR pile re-derived · `svc-support` missing · D-S-01…18 incomplete · FUTURE thinner than tracker.

---

## 0 · Verdict (peace of mind)

| Question                  | Answer                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- |
| Massive in-repo leverage? | **Yes** — `vendor/upstream-exchange` kit + 18 TS services + packages + compose    |
| Product UI law?           | **Yes** — sole product surface = vendor shell **:8090**; `apps/web` **gone**      |
| Fully using kit?          | **No** — shell primary; Java money **not** book; wallet RPC not live until review |
| Biggest rebuild risk (N)? | New UI for kit screens; ignore ledger-client; second terminal                     |
| Biggest rebuild risk (D)? | Specs without kit+ledger mandate; dual-edit; invent mids                          |
| Forbidden leverage?       | Java balances as SoT; invent prices; unaudited wallet_rpc mainnet                 |

**One line:** Kit for product **shape/screens**; **ledger-client** for money truth; wire the gap — do not rebuild either blindly.

---

## 1 · Prior maps status (E1) — tip 2026-08-05

| Prior doc                                                             | Status                               | Action                                              |
| --------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------- |
| ADR adopt vendored product + keep ledger (2026-08-02)                 | **Law**                              | Keep                                                |
| ADR retire apps/web → Vue shell (2026-08-03)                          | **Law** + **executed** (#757 delete) | Keep port notes only                                |
| ADR vendored exchange integration (2026-07-28)                        | **Law**                              | Keep                                                |
| VENDORED-SHELL-PEACE-OF-MIND-MAP                                      | Useful; paths may lag rename         | Map; path = `vendor/upstream-exchange`              |
| VENDORED-OVERLAP-AUDIT                                                | Historical                           | Don’t cite fleet counts without re-probe            |
| UPSTREAM-ADOPTION-QUEUE                                               | Queue                                | Re-check when acting                                |
| REDUNDANT-VS-PORT                                                     | Port checklist                       | Mostly absorbed by delete; residual port ideas only |
| ORDER-ROUTE-VENDOR-MONEY-INVENTORY                                    | Money seams                          | Dual-book / Java residual                           |
| ADMIN-0-INVENTORY-VENDOR-VS-APPS                                      | Admin map                            | Prefer V-ADMIN                                      |
| brand/path docs saying pre-rename vendor path / upstream product name | **Stale brand risk**                 | brand-scan; vendor rename                           |

---

## 2 · Leverage asset register (E2)

### 2.1 Vendored kit — `vendor/upstream-exchange`

| Asset ID                      | Path                                                       | Kind        | Use?                                     | Owner care    |
| ----------------------------- | ---------------------------------------------------------- | ----------- | ---------------------------------------- | ------------- |
| **V-SHELL**                   | `05_Web_Front`                                             | Trader UI   | **YES — sole product UI**                | N             |
| **V-ADMIN**                   | `04_Web_Admin`                                             | Operator UI | **YES — workflows**                      | N/D           |
| **V-JAVA-admin**              | `00_framework/admin`                                       | Java        | Shape only — not book                    | D policy      |
| **V-JAVA-exchange**           | `00_framework/exchange` + `exchange-api` + `exchange-core` | Java        | Shape / study; **not** Fiat matching SoT | D             |
| **V-JAVA-market**             | `00_framework/market`                                      | Java        | Shape                                    | D             |
| **V-JAVA-otc**                | `00_framework/otc-api` + `otc-core`                        | Java        | Workflow shape for OTC                   | D/N after law |
| **V-JAVA-ucenter**            | `00_framework/ucenter-api`                                 | Java        | Shape                                    | D             |
| **V-JAVA-wallet**             | `00_framework/wallet`                                      | Java        | **Forbidden as book**                    | D-S-17        |
| **V-JAVA-chat**               | `00_framework/chat`                                        | Java        | Shape only                               | —             |
| **V-JAVA-job**                | `00_framework/job-module`                                  | Java        | Ops shape                                | —             |
| **V-JAVA-cloud/core/sql/jar** | cloud, core, sql, jar                                      | Support     | Infra/shape                              | —             |
| **V-WALLET-RPC**              | `01_wallet_rpc/*`                                          | Custody RPC | After **security review** only           | D + X         |
| **V-DOC**                     | `09_DOC`                                                   | Notes       | Reference                                | —             |
| **V-MOBILE**                  | `02_App_Android`, `03_APP_IOS`                             | Stubs       | **No source**                            | Future        |
| **V-ROBOT**                   | `06_ExchangeRobot`                                         | Stub        | Out                                      | —             |
| **V-COMPOSE**                 | monorepo `vendor-shell` + kit compose                      | Fleet       | Shell **:8090**                          | Ops           |

**Overlays (ours):** `05_Web_Front/.../pages/intafaced/*` — Academy, Agents, Bank, Blueprint, Chain, Dex, Launch, Pay, P2P, Platform, Protocol, Token, NotBuilt, …

### 2.2 TypeScript services (complete tip list — 18)

| Asset ID    | Service                                 | Leverage                                 |
| ----------- | --------------------------------------- | ---------------------------------------- |
| S-LEDGER    | `svc-ledger` + `packages/ledger-client` | **Only book**                            |
| S-ID        | `svc-identity`                          | Accounts, rank, keys, KYC surfaces       |
| S-TOKEN     | `svc-token`                             | IFC stake/emissions (honest residuals)   |
| S-MATCH     | `svc-matching`                          | Fiat matching SoT                        |
| S-TRADE     | `svc-trade`                             | Spot/convert done; futures residual      |
| S-PAY       | `svc-pay`                               | Crypto rail done; card/gateway residual  |
| S-BANK      | `svc-bank`                              | Accounts/loans done; earn/cards residual |
| S-P2P       | `svc-p2p`                               | P2P product                              |
| S-WS        | `svc-ws`                                | Depth/stream platform                    |
| S-EDGE      | `svc-edge`                              | API edge                                 |
| S-PROTOCOL  | `svc-protocol`                          | **Shehzad**                              |
| S-DEX       | `svc-dex`                               | **Shehzad** gravity                      |
| S-INDEXER   | `svc-indexer`                           | Chain read models                        |
| S-NOTIFY    | `svc-notify`                            | Fan-out                                  |
| S-AGENTS    | `svc-agents`                            | Navigator/scanner/…                      |
| S-ACADEMY   | `svc-academy`                           | Lobbies/curriculum                       |
| S-BLUEPRINT | `svc-blueprint`                         | Blueprint                                |
| S-SUPPORT   | `svc-support`                           | Support desk backend                     |

### 2.3 Packages (complete tip)

`auth` · `config` · `contracts` · `db` · `events` · `exchange-contract` · `i18n` · `ledger-client` · `market-data` · `ui` · `venue-adapter` · `venue-contracts`

### 2.4 Apps

| Path         | Role                                                   |
| ------------ | ------------------------------------------------------ |
| `apps/web`   | **Deleted** (#757) — not a product surface             |
| `apps/admin` | Present — prefer **V-ADMIN** for exchange ops patterns |

### 2.5 Infra

Postgres 16 · Redis 7 · NATS · OTEL · vendor-shell image — **do not rebuild**.

---

## 3 · PAST — done leverage (E3)

| Work                         | Leverage used       | Proof              |
| ---------------------------- | ------------------- | ------------------ |
| Product UI = shell           | V-SHELL             | ADR 08-02 / 08-03  |
| apps/web product role killed | Delete #757         | tip tree           |
| Ledger-only money            | ledger-client       | ADR 07-28; scans   |
| Shell :8090                  | V-SHELL + compose   | fleet              |
| Spot/convert                 | S-TRADE + Exchange  | tracker done       |
| WS depth platform            | S-WS + nginx        | #727 #737          |
| WS depth **client**          | V-SHELL + ix-depth  | **#748**           |
| Pay crypto rail              | S-PAY               | pay.rails done     |
| Bank accounts/loans          | S-BANK              | tracker done       |
| Identity core                | S-ID                | tracker done       |
| Matching                     | S-MATCH             | tracker done       |
| Market-id authority ADR      | S-WS/S-EDGE/S-MATCH | #746               |
| Vendor rename                | path hygiene        | #771               |
| Brand/honesty residual       | scans + shell       | ongoing            |
| Wallet RPC auth on modules   | V-WALLET-RPC        | #720 (not go-live) |

**Past debt:** kit **breadth** (OTC desk, admin finance, full admin) still shape > product path; Java balances must never become book.

---

## 4 · NOW — active × leverage (E4)

### 4.1 Open PRs (re-derived tip — not folklore)

| PR       | Author  | Leverage note                                                          | Dual-build risk          |
| -------- | ------- | ---------------------------------------------------------------------- | ------------------------ |
| **#428** | Denon   | P2P payment instruments — **his** branch                               | Agents: **babysit only** |
| **#346** | Shehzad | Pay M1 gateway — operator handoff asserted; path-check before residual | No dual-edit             |

Any other “open Denon money pile” claims must be re-`gh pr list`’d — do not cite old #448-class lists without re-derive.

### 4.2 Nitro / agents now

| Work                        | Best leverage                          | Using?                                                           | Action                               |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Depth live **E2E residual** | #748 client + S-WS + fleet             | Partial — client exists; `feedLive` starts false until connected | Prove live path; no new terminal     |
| Decimal desk                | Vendored bignumber                     | Partial                                                          | Wire ix-trade                        |
| Shape validation            | Port discipline (not resurrect Next)   | Partial                                                          | One schema lib later = Phase B       |
| Pay residual after handoff  | S-PAY + shell Pay                      | After #346 clear                                                 | Extend svc-pay — no new pay UI stack |
| Platform craft              | V-SHELL Platform + cms                 | Should                                                           | Kit first                            |
| Honesty scans               | fabricated-money + brand               | Active                                                           | Keep                                 |
| freeProduct residual craft  | Matching tracker row’s service + shell | Active                                                           | Prefer path-clean land               |

### 4.3 Denon now

| Work                           | Best leverage                     | Action               |
| ------------------------------ | --------------------------------- | -------------------- |
| Land/close **#428** path       | S-P2P + ledger                    | His merge discipline |
| Spec factory D-S-01…18         | Name kit screens + ledger recipes | **Unblocks** agents  |
| D-S-06 dual-target             | One matching **spec**             | With Shehzad         |
| Fleet/images                   | Existing Dockerfiles              | Rebuild not redesign |
| Wallet RPC review program      | V-WALLET-RPC                      | Before live custody  |
| D-S-17 Java dual-book residual | Scans                             | Policy + residual    |

---

## 5 · FUTURE — every non-done tracker mountain (E5)

Default: **IN** leverage first. **GF** only if no asset. **LAW** = Denon D-S. **S** = Shehzad. **X** = Class X.

### 5.1 Trade / venue / terminal / WS

| ID                | Default leverage           | GF OK?           | Notes                               |
| ----------------- | -------------------------- | ---------------- | ----------------------------------- |
| trade.futures     | S-TRADE + S-WS + kit shape | After **D-S-01** | No invent mids                      |
| trade.options     | S-TRADE patterns           | After law        | LATE                                |
| trade.otc         | Kit otc + ledger           | After **D-S-02** | No UI rewrite                       |
| trade.copy        | Engine GF + shell          | After **D-S-03** |                                     |
| trade.algo        | Engine GF + shell          | After **D-S-04** | Study Nautilus only later (Phase B) |
| trade.forex       | Same engine                | After **D-S-05** |                                     |
| trade.ccxt-api    | Public API shape           | Care             | **No CCXT money path**              |
| trade.mm-bot      | S-TRADE                    | Thin             | N ready                             |
| venue.aggregation | venue-adapter              | Partial          |                                     |
| web.terminal      | V-SHELL                    | Residual wire    | decimals + live prove               |
| ws.gateway        | S-WS                       | Partial          | Positions need D-S-01               |

### 5.2 Pay / bank / p2p

| ID                                                                               | Default leverage     | Notes                                   |
| -------------------------------------------------------------------------------- | -------------------- | --------------------------------------- |
| pay.gateway/psp/payfac/routing/settlement/fraud/subscriptions/plugins/public-api | S-PAY + shell Pay    | **D-S-10**; EXT orchestration = Phase B |
| socket.psp-partners                                                              | Adapters only        | **X**                                   |
| bank.earn/cards/ramps                                                            | S-BANK + shell Bank  | **D-S-09**; issuer **X**                |
| bank.sovereign-card                                                              | S-BANK + S SA        | Split N/S                               |
| socket.live-issuer                                                               | —                    | **X**                                   |
| p2p.merchants                                                                    | S-P2P + shell        |                                         |
| P2P disputes                                                                     | Human desk GF + SPEC | **D-S-08**; ReDoS Phase B               |

### 5.3 Identity / token / notify / ops

| ID                                        | Default leverage                | Notes                               |
| ----------------------------------------- | ------------------------------- | ----------------------------------- |
| identity money graph                      | S-ID + shell sub-accounts       | **D-S-11**                          |
| token.yield/buyback/governance            | S-TOKEN honesty                 | **D-S-14** numbers; sockets         |
| ops.notifications + notify sockets        | S-NOTIFY                        | EXT channel SDKs Phase B            |
| ops.support                               | S-SUPPORT + desk                | Prefer not second ticket SaaS day-1 |
| ops.affiliates/compliance/analytics/admin | apps/admin + V-ADMIN + services | Analytics warehouse = Phase B late  |
| ops.compliance screening content          | Queues IN                       | List **content** **X**              |
| infra.i18n                                | packages/i18n                   |                                     |

### 5.4 Agents / academy / market

| ID                      | Default leverage         | Notes                  |
| ----------------------- | ------------------------ | ---------------------- |
| agents.\*               | S-AGENTS                 | No invent money        |
| academy.\*              | S-ACADEMY + kit overlays | VR/stream sockets late |
| market.vendors/commerce | Shell + services         |                        |

### 5.5 Protocol / chain / bridge / launch / dex / mining (S)

| ID                                                                                     | Default leverage                    | Notes                     |
| -------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------- |
| protocol.\* / chain.\* / bridge.\* / launch.\* / mining.\* / dex.\* / contract sockets | S-PROTOCOL, S-DEX, S-INDEXER, forge | **S only**; Nitro babysit |
| socket.mpc-custody                                                                     | After wallet review                 | Phase B EXT + **X**       |
| socket.rust-matching                                                                   | Dual-target **D-S-06**              | LATE                      |
| socket.ledger-sharding                                                                 | Scale                               | LATE                      |

### 5.6 Mobile

| ID                    | Default leverage | Notes                              |
| --------------------- | ---------------- | ---------------------------------- |
| V-MOBILE / future app | **None** (stubs) | GF when product yes — Phase B late |

---

## 6 · Forbidden leverage (E6)

| Temptation                               | Why                            |
| ---------------------------------------- | ------------------------------ |
| Java MemberWallet / dual balances as SoT | Doctrine ledger only           |
| Invent mids/depth to look live           | Honesty                        |
| Partner/PSP names in user copy           | Brand — adapters only          |
| wallet_rpc mainnet without review        | Custody X                      |
| Resurrect apps/web as product            | ADR + deleted                  |
| Agents implement Shehzad protocol cores  | Ownership                      |
| Dual-edit Denon open PR files            | Collision                      |
| New full exchange UI kit                 | Rebuild V-SHELL                |
| CCXT on money path                       | Floats + doctrine              |
| Formance/TigerBeetle as ledger SoT       | Second book (Phase B kill too) |

---

## 7 · Gap register (E7)

### P0

| ID     | Gap                                                 | Who             | Action                             |
| ------ | --------------------------------------------------- | --------------- | ---------------------------------- |
| G-P0-1 | Depth **E2E** residual (client shipped; prove live) | N               | Fleet + connect proof — no new app |
| G-P0-2 | Decimal desk not end-to-end                         | N               | Wire bignumber                     |
| G-P0-3 | Pay residual after #346                             | N after handoff | Extend S-PAY                       |
| G-P0-4 | Denon open work unlanded (#428…)                    | D               | Land his PRs                       |
| G-P0-5 | Engines without D-S-01…05                           | D then N        | Spec factory                       |

### P1

| ID     | Gap                                   | Who         | Action                 |
| ------ | ------------------------------------- | ----------- | ---------------------- |
| G-P1-1 | OTC/admin/CMS not full product path   | N after law | Kit screens + ledger   |
| G-P1-2 | V-ADMIN not primary ops story         | N/D         | Prefer V-ADMIN         |
| G-P1-3 | Doc path drift                        | Agents      | Fix when touching      |
| G-P1-4 | Wallet RPC unused without review      | D           | Review program         |
| G-P1-5 | svc-support under-used vs ops.support | N           | Wire desk to S-SUPPORT |

### P2

| ID     | Gap                               | Who | Action            |
| ------ | --------------------------------- | --- | ----------------- |
| G-P2-1 | apps/web confusion                | —   | **Closed** (#757) |
| G-P2-2 | spine-\* pile                     | D   | Disposition list  |
| G-P2-3 | Stale fleet numbers in old audits | —   | Re-probe          |

---

## 8 · D-S-01…18 — leverage mandate (plan gate)

| D-S                      | Spec must mandate                                                                     | N/A?        |
| ------------------------ | ------------------------------------------------------------------------------------- | ----------- |
| 01 Futures risk          | UI: kit futures/exchange shape; money: ledger recipes; marks: refuse rules not invent |             |
| 02 OTC                   | Kit otc workflow; ledger stake/spread recipes                                         |             |
| 03 Copy                  | Shell follow UI; ledger profit-share recipe                                           |             |
| 04 Algo                  | Shell order UI; no fake fills; study-only external engines                            |             |
| 05 Multi-asset           | Enum authority in contracts; refuse-closed                                            |             |
| 06 Matching dual-target  | **One matching spec**; Fiat = S-MATCH; chain = S later                                |             |
| 07 Oracle/mark           | Refuse rules; no vendor mid as truth                                                  |             |
| 08 P2P dispute           | Human desk; custody escrow Fiat; no Kleros default                                    |             |
| 09 Bank                  | S-BANK + shell Bank; issuer adapters Class X                                          |             |
| 10 Pay beyond crypto     | S-PAY + shell Pay; orchestration adapter later                                        |             |
| 11 Identity graph        | S-ID; shell sub-account; no second identity service                                   |             |
| 12 Bridge accounting     | Ledger IFC ↔ chain IFC; S builds chain                                                |             |
| 13 Event bus             | packages/events + existing NATS; explicit §13 sockets                                 |             |
| 14 Token economics       | Numbers from you/spec only; S-TOKEN honesty                                           |             |
| 15 Platform IA           | V-SHELL platform pages; no apps/web                                                   |             |
| 16 Class M hold language | Process — no package                                                                  | N/A package |
| 17 Java dual-book        | Scans + residual; never adopt Java book                                               |             |
| 18 Predict/quant/connect | Invent ban until law; shell only if in scope                                          |             |

---

## 9 · Hole hunt (E8) — refresh

| Hunt                    | Result                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missed service?         | **svc-support** was missed — **added**                                                                                                                         |
| apps/web still product? | **No** — deleted                                                                                                                                               |
| Vendor path?            | **upstream-exchange**                                                                                                                                          |
| Depth client?           | **#748** — E2E residual remains                                                                                                                                |
| Open PR folklore?       | Re-derived #428 #346                                                                                                                                           |
| D-S full set?           | **Filled §8**                                                                                                                                                  |
| Tracker FUTURE breadth? | **§5** all domains                                                                                                                                             |
| Phase B mixed in?       | **No** candidates — boundary §11                                                                                                                               |
| Mobile leverage?        | Still none                                                                                                                                                     |
| Charting shop?          | **[STALE 2026-09-01]** LWC is **interim**. Intended host: TradingView Advanced Charts pending (`LICENCE-POSITION.md` §1.1a). This Phase A audit is historical. |

---

## 10 · Actions (E9)

**Nitro:** prove depth E2E; decimal wire; after pay handoff extend S-PAY; kit-first platform; never new SPA.  
**Denon:** #428 discipline; D-S factory with leverage mandates; wallet review; Java dual-book residual.  
**You:** Class X only; optional Denon nudge for law factory.

---

## 11 · Phase B boundary

Search **new external** only for holes this audit leaves open (security parsers, secrets CI, multi-PSP orchestration, passkeys, ACH file libs, KYC adapters, custody vendors after review, mobile stacks, chain **refs for S**, etc.).  
**Not:** second UI kit; second ledger; invent mids.

**Gate:** Phase B plan + methodology audit require this refresh **green** before B0.

---

## 12 · Completeness (plan §8) — refresh self-check

- [x] Every tip `services/svc-*` (18)
- [x] Vendor shell + admin + Java modules named
- [x] Packages complete
- [x] Open PRs re-derived
- [x] D-S-01…18 leverage mandates
- [x] Nitro NOW mapped (incl. #748 residual)
- [x] FUTURE all tracker domains
- [x] Forbidden explicit
- [x] Prior maps status
- [x] Hole hunt named
- [x] No Phase B shopping
- [x] Durable tip path

**Phase A proper: YES (after this refresh lands on tip).**

---

_Board-Delta: Phase A internet leverage audit refreshed — tip drift + plan §8 gates closed_
