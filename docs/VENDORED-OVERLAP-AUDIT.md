# Vendored overlap audit — what the Java platform does, what we are rebuilding, and what it costs

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Type:** audit. Evidence and options. **No code was changed.**
**Question asked:** _"the vendored app was fully complete with all functionality of a crypto trading app — is all of this being used?"_
**Probed:** 2026-07-30, live fleet on this machine, against `main` @ `207c8a6`.
**Decision owner:** repo owner. Nothing here is a decision.

---

## The three answers, up front

**1. The balance-ownership decision in [`docs/adr/2026-07-28-vendored-exchange-integration.md`](adr/2026-07-28-vendored-exchange-integration.md) was never taken.** Not in a later ADR, not in `docs/DECISIONS-2026-07-30.md`, not in `docs/OWNER-DECISIONS-OPEN.md`, not in any merged PR. Evidence in §1. This is the most important finding in this document, because every bucket below is downstream of it.

**2. No, almost none of the vendored app is being used.** Four of its fifteen Java modules are running; the rest have never been started. The database behind it holds **zero members, zero wallets, zero orders, zero adverts** — nobody has ever registered on it. The one thing genuinely in the product path is the **Vue front-end shell**, and 11 of its 41 screens are ours, not theirs. Evidence in §3.

**3. The suspicion is half right, and the half that is wrong matters more.** We are duplicating _product surface_ (OTC screens, fiat request flows, notification fan-out) that the vendored app already drew. We are **not** duplicating anything the vendored app _does_ correctly with money — because the way it does money is the thing Doctrine §0.6 exists to forbid, and its own money layer has never processed a single transaction here.

---

## 1. Was the balance-ownership decision ever made?

**No.** Here is everything I checked and what each said.

| Where I looked                                                                                                    | What it says                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/adr/2026-07-28-vendored-exchange-integration.md`](adr/2026-07-28-vendored-exchange-integration.md), line 3 | **`Status: In progress`** — still. Lines 58–80 lay out A / B / C and end at _"Recommendation: C to get running, B as the target."_ A recommendation, in a doc that never got a Status line change.    |
| [`docs/adr/2026-07-28-vendored-exchange-ui.md`](adr/2026-07-28-vendored-exchange-ui.md), line 95                  | Points _back_ at the integration ADR for "the balance-ownership decision". It defers; it does not decide.                                                                                             |
| `docs/DECISIONS-2026-07-30.md`                                                                                    | Four decisions recorded (CI merge protocol, chart licence, JDBC driver, multi-asset merge). **Balance ownership is not among them**, and its "Not decided here" list does not mention it either.      |
| `docs/OWNER-DECISIONS-OPEN.md`                                                                                    | Four decisions closed (charts, sanctions, JDBC, CORS). Not this one.                                                                                                                                  |
| `docs/decisions/` (4 files)                                                                                       | `P0-3-purpose-keyed-holds.md`, `kyc-posture.md`, `mount-boundary.md`, `s2s-body-bind.md`. None is about balance ownership.                                                                            |
| `git log --all --grep` for `member_wallet` / `Option B` / `Option C` / `boundary account` / `ledger owns`         | **4 commits, all of them the vendoring itself** (`4b1daff`, `a19e337`, `445f2bf`, `c221cc8`). No commit records a decision.                                                                           |
| `git log --all -- docs/adr/`                                                                                      | Last touch to the ADR directory is `60031cf` (#86). Nothing since #86 amended it.                                                                                                                     |
| `docs/POST-MERGE-RESIDUAL-AFTER-86.md`, open item **#1**                                                          | _"Shell ≠ books discipline (demo must not sell shell balance as truth)"_ — owner **All**, when **Now**. An open risk on a living queue.                                                               |
| `docs/PROPER-CLEANUP-AFTER-DENON.md`, **T2-1**                                                                    | Filed under _"Track 2 — **You decide once** (product / fear)"_: _"**Dual-book forever?** Default already: shell = UI, TS ledger = books."_ Explicitly addressed to the owner, explicitly not settled. |
| `docs/DENON-NITRO-PARALLEL-BOARD-2026-07-30.md`, line 19                                                          | _"dual-book **policy** under live demo"_ is listed under **"Nitro human only"** — i.e. reserved for a human, still pending.                                                                           |

**What exists instead of a decision is a habit with a partial enforcement.** `tooling/ci/vendor-shell-scan.mjs` bans **seven** specific mint patterns inside `vendor/**` (mass `+500` credit, `TRUNCATE member_wallet_*`, `MiningsJob` credit, the `BHB` mint SQL, and so on). It runs clean today — 1,105 files, 7 patterns.

**It does not ban the mutators every real money path actually uses.** `core/.../dao/MemberWalletDao.java` still declares, live:

```java
@Query("update MemberWallet wallet set wallet.balance = wallet.balance + :amount where wallet.id = :walletId")
int increaseBalance(...);
@Query("update MemberWallet wallet set wallet.balance = wallet.balance - :amount, wallet.frozenBalance = wallet.frozenBalance + :amount where wallet.id = :walletId and wallet.balance >= :amount")
int freezeBalance(...);
```

Bare `UPDATE`. No journal, no double entry, no idempotency key, no sum-to-zero. **25 of the 94 controllers reach these** (list in §5). So the quarantine covers the exotic mint paths somebody found in an audit, and leaves the ordinary ones — withdraw, OTC escrow, CTC, fiat approval — completely live.

**Also, and this is not covered anywhere:** `tooling/ci/custody-scan.mjs` walks `['.ts', '.tsx']` only (line 80). **It has never read a line of Java.** The doctrine gate that is supposed to catch a module holding its own balance is structurally blind to the module that holds its own balance.

> **This is the finding to act on.** Every bucket below has a different answer depending on A, B or C, and there is no way to get the buckets right by engineering. It needs the owner.

---

## 2. The raw numbers, verified

| Claim                        | Verified                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 94 Java controllers          | **Confirmed, with the arithmetic.** `find … -name '*Controller.java'` returns **108**. Minus 13 in `01_wallet_rpc` (12 per-chain `WalletController` + `RpcController`), minus `wallet/…/TestController.java` → **94.**        |
| 41 Vue screens               | **Confirmed as a count, wrong as a claim about the vendor.** `05_Web_Front/src/pages/**/*.vue` = 41. **11 of them are `pages/intafaced/` — ours**, added in #86. Vendored screens = **30**, which matches the UI ADR's "~30". |
| across the 10 named areas    | Confirmed: `activity`(4) `cms`(7) `ctc`(1) `envelope`(1) `exchange`(1) `index`(1) `intafaced`(11, ours) `invite`(1) `otc`(7) `uc`(7).                                                                                         |
| 16 TypeScript services       | Confirmed — `ls services` = 16.                                                                                                                                                                                               |
| The named controllers exist  | All confirmed on disk. Paths in §5.                                                                                                                                                                                           |
| **Not in the brief:** admin  | `04_Web_Admin` is a **further 92 `.vue` files** — a complete admin console. Never mentioned, never started.                                                                                                                   |
| **Not in the brief:** mobile | `02_App_Android` and `03_APP_IOS` are also in the tree. Not examined by anyone, per the ADR's "Not yet done".                                                                                                                 |

So the vendored surface is **larger** than the brief said, and the part of it that is _ours_ is larger too.

---

## 3. What actually runs — live probes, 2026-07-30

### 3.1 Which vendored modules are up

`docker ps`, filtered to the vendored stack:

| Module                | Container                       | Port      | State                                         |
| --------------------- | ------------------------------- | --------- | --------------------------------------------- |
| `cloud` (Eureka)      | `intafaced-coinex-cloud`        | 7000      | up 2 days                                     |
| `exchange` (matching) | `intafaced-coinex-exchange`     | —         | up 31h — logs show **only** Eureka heartbeats |
| `exchange-api`        | `intafaced-coinex-exchange-api` | 6003      | up 31h                                        |
| `market`              | `intafaced-coinex-market`       | 6004      | up 23h                                        |
| `ucenter-api`         | `intafaced-coinex-ucenter`      | 6001      | up 31h                                        |
| `otc-api`             | `intafaced-coinex-otc`          | 6006      | up 31h                                        |
| `05_Web_Front` shell  | `intafaced-shell-web`           | 8090      | up 7h (127.0.0.1 only)                        |
| **`admin`**           | —                               | —         | **jar built, never started**                  |
| **`job-module-job`**  | —                               | —         | **jar built, never started**                  |
| **`chat`**            | —                               | —         | **jar built, never started**                  |
| **`wallet`**          | —                               | —         | **jar built, never started**                  |
| **`01_wallet_rpc`**   | —                               | 12 chains | **not built, deliberately shut** (`c221cc8`)  |

Four of fifteen framework modules run. **The admin module — 57 of the 94 controllers — has never been started**, which means every approval step in the vendored money flows (fiat recharge pass, withdraw approval, OTC appeal release) is unreachable today.

### 3.2 What those four answer

```
GET  http://localhost:6004/market/symbol-thumb
  → [{"symbol":"BTC/USDT","open":118021.04,"close":118450.00,"volume":0.0000, …}]

GET  http://localhost:6003/exchange/exchange-coin/base-symbol
  → {"data":["USDT"],"code":0,"message":"SUCCESS"}

POST http://localhost:6006/otc/coin/all
  → {"data":[],"code":0,"message":"SUCCESS"}

POST http://localhost:6006/otc/advertise/page-by-unit  (unit=USDT)
  → {"data":null,"code":500,"message":"validate otcCoin unit!"}

POST http://localhost:6001/uc/asset/wallet
  → {"code":4000,"message":"<session expired — login required>"}
```

Read those carefully:

- **Market data is alive and synthetic.** `vendor/upstream-exchange/seed-market-data.mjs` says so in its own header: _"KNOWN LIMIT — this seeds history, it does not simulate a live market… Until real fills exist, run it daily."_ Note `volume: 0.0000`.
- **The OTC desk is running with zero coins configured.** `otc/coin/all` returns `[]`, and every advert query therefore refuses with `validate otcCoin unit!`. The "complete OTC desk" is up, and **it cannot serve a single request that involves an advert.**
- **The OTC service is doing work against nothing.** Its logs show `CheckOrderTask` running its expiry sweep every minute over an empty `otc_order` table, and `CheckExchangeRate` pulling `USDT rate = 7.00` (a CNY rate).

### 3.3 The database behind it

`upstream` on `localhost:5506`, exact counts:

| table                                                               | rows  |
| ------------------------------------------------------------------- | ----- |
| `member`                                                            | **0** |
| `member_wallet`                                                     | **0** |
| `member_transaction`                                                | **0** |
| `exchange_order`                                                    | **0** |
| `otc_order`, `advertise`, `otc_coin`                                | **0** |
| `ctc_order`, `ctc_acceptor`                                         | **0** |
| `withdraw_record`, `legal_wallet_recharge`, `legal_wallet_withdraw` | **0** |
| `admin`                                                             | **0** |
| `coin`                                                              | 11    |
| `exchange_coin`                                                     | 10    |
| _(all 63 other tables)_                                             | 0     |

**Nobody has ever registered on the vendored platform. No wallet has ever existed. No order has ever been placed.** The only rows anywhere are market metadata.

### 3.4 Our stack, same day, for contrast

`intafaced` on `localhost:5433`:

| table                   | rows      |
| ----------------------- | --------- |
| `identity.users`        | **7,192** |
| `ledger.accounts`       | 58        |
| `ledger.ledger_tx`      | 52        |
| `ledger.ledger_entries` | 120       |
| `ledger.assets`         | 17        |
| `trade.markets`         | 16        |
| `trade.orders`          | 0         |
| `p2p.offers`            | 1         |
| `p2p.p2p_trades`        | 1         |
| `bank.loans`            | 0         |
| `pay.payments`          | 0         |

**Honesty about this table:** the 7,192 users are test pollution — the count grew by 87 during this audit, and it is the same shared-database pollution that breaks `svc-identity`'s KYC test. `ledger.accounts` at 58 is likewise test residue. **Neither system has a real user.** The right framing is not "which one is live" — it is **"which one do we build on"**, and that is exactly the ADR question.

### 3.5 Where the two stacks touch

**They do not touch in code.** `grep -il "coinex|vendored|upstream"` across `services/ packages/ apps/ tooling/` returns three files, and all three are scanners or a test fixture — `brand-scan.mjs`, `secret-scan.mjs`, `uiproof/auth-fixture.mjs`. **No TypeScript service calls any Java service, and no Java service calls any TypeScript service.** No port in the 6000s appears anywhere in our source.

They touch in exactly one place: **the browser**. `vendor/upstream-exchange/05_Web_Front/config/index.js` proxies `/uc`, `/market`, `/exchange`, `/otc` to the four Java services **and** `/api` to our `svc-edge` on 4000. The shell's own comment on the `/api` entry is careful and correct:

> _"ONE entry, not one per service. svc-edge (§9) is the front door… A proxy entry per service port would bypass all three."_

So a user in that shell logs in against the Java `member` table via `/uc`, and reads `svc-bank` balances via `/api`. **Two identity systems and two balance systems in one page.** `docs/STREAM-A-PHASE1-PLAN.md` already names the rule that patches over it — _"Vendor wallet endpoints are exchange shell balances, not TypeScript ledger books. UI must not imply 'platform books'"_ — which is a labelling discipline, not an architecture.

---

## 4. Capability matrix

"Runs" = probed today. "Ours" = TypeScript equivalent. "State" = `docs/TRACKER.md`.

| #   | Vendored capability                   | Where                                                                                | Runs?                                              | Ours                                     | State                                       | Overlap      |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------- | ------------------------------------------- | ------------ |
| 1   | Spot order lifecycle                  | `exchange-api/…/OrderController`, `exchange` module                                  | ✅ 6003 (0 orders ever)                            | `svc-trade` + `svc-matching`             | `trade.spot` ✅ `matching.engine` ✅        | **full**     |
| 2   | Market data, klines, depth            | `market/…/MarketController` (13 routes)                                              | ✅ 6004, **synthetic seed**                        | `svc-ws`, `packages/market-data`         | `ws.depth` ✅ `trade.ccxt-api` 🟢 partial   | **full**     |
| 3   | OTC desk — advert, order, appeal      | `otc-api/…/{Advertise,Order}`, `admin/…/otc/{AdminAdvertise,AdminAppeal,AdminOrder}` | ⚠️ 6006 up, **0 coins → unusable**; admin **down** | `svc-p2p`                                | `p2p.offers/escrow/disputes/reputation` ✅  | **full**     |
| 4   | CTC — fiat acceptor desk              | `ucenter-api/…/CtcController`, `admin/…/ctc/*`                                       | ⚠️ 6001 up; admin half **down**                    | nearest is `svc-p2p`; no direct analogue | —                                           | **partial**  |
| 5   | Fiat rails — recharge / withdraw      | `ucenter-api/…/LegalWallet*`, `admin/…/member/LegalWallet*`                          | ⚠️ request side up; **approval side down**         | `svc-pay` deposit/withdrawal             | `pay.user-money` ⛔ (on `pay.rails`)        | **full**     |
| 6   | Crypto deposit / withdraw / on-chain  | `ucenter-api/…/{Withdraw,Transfer,Asset}`, `01_wallet_rpc`, `wallet`                 | ❌ RPC deliberately shut (`c221cc8`)               | `svc-protocol`, `svc-dex`, `svc-indexer` | `pay.rails` ⛔ `protocol.smart-accounts` 🟢 | **partial**  |
| 7   | **Balances**                          | `core/…/MemberWalletService` + `MemberWalletDao`                                     | ✅ live in-process, 0 rows                         | `packages/ledger-client` + `svc-ledger`  | `ledger.double-entry` ✅                    | **CONFLICT** |
| 8   | Identity — register, login, 2FA, KYC  | `ucenter-api/…/{Register,Login,Approve,GoogleAuthentication}`                        | ✅ 6001                                            | `svc-identity`                           | `identity.*` ✅ (7 shipped)                 | **full**     |
| 9   | Member levels / tiers                 | `admin/…/member/MemberLevelController`                                               | ❌ admin down                                      | `svc-identity` rank                      | `identity.rank` ✅                          | **full**     |
| 10  | Notifications / SMS                   | `ucenter-api/…/SmsController`, `admin/…/code/SmsProviderController`                  | ⚠️ partial                                         | `svc-notify`                             | `ops.notifications` 🟢                      | **full**     |
| 11  | Merchant KYB                          | `admin/…/businessAuth/*`                                                             | ❌ admin down                                      | `svc-pay` PSP/PayFac                     | `pay.psp` ⛔ `pay.payfac` ⛔                | **full**     |
| 12  | Promotions, invite, rewards           | `ucenter-api/…/PromotionController` (12 routes), `admin/…/promotion/*`               | ⚠️ user side up                                    | —                                        | `ops.affiliates` 🟢 not started             | **none**     |
| 13  | Red envelope                          | `ucenter-api/…/RedEnvelopeController` (9 routes), `admin/…/redenvelope/*`            | ⚠️ user side up                                    | —                                        | not in the tracker at all                   | **none**     |
| 14  | Mining orders                         | `ucenter-api/…/MiningOrderController`                                                | ⚠️ up (`MiningsJob` mint **quarantined**)          | —                                        | `mining.pool` 🟢 not started                | **none**     |
| 15  | Dividend distribution                 | `admin/…/system/DividendController`                                                  | ❌ admin down                                      | `svc-token` yield                        | `token.yield` ✅                            | **full**     |
| 16  | CMS — announcements, help, whitepaper | `admin/…/cms/*`, `ucenter-api/…/{Announcement,Aide,Feedback}` + 7 screens            | ⚠️ read side up                                    | —                                        | not in the tracker                          | **none**     |
| 17  | Admin console                         | 57 controllers + `04_Web_Admin` (92 `.vue`)                                          | ❌ never started                                   | `apps/admin` (:3100)                     | `ops.admin` 🟢                              | **partial**  |
| 18  | Support chat                          | `chat` module (2 controllers)                                                        | ❌ never started                                   | —                                        | `ops.support` 🟢                            | **none**     |
| 19  | Statistics / finance reporting        | `admin/…/system/StatisticsController`, `admin/…/finance/*`                           | ❌ admin down                                      | —                                        | `ops.analytics` 🟢                          | **none**     |
| 20  | Activity / sign-in / bonus            | `ucenter-api/…/{Activity,Bonus}`, `admin/…/activity/*`                               | ⚠️ user side up                                    | —                                        | —                                           | **none**     |

**Read the "Overlap" column as the answer to the owner's question.** Eight capabilities are **full** overlap — we have built, or are building, what the vendored app already has. Seven are **none** — the vendored app has something we have nothing for, and in five of those seven the tracker has no entry at all.

---

## 5. The three buckets

### Bucket 1 — REBUILD IS REQUIRED

**Placement rule:** it writes `member_wallet`. Doctrine §0.6 says no module holds its own balance; §4.2 says the journal is the record. A vendored path that credits a balance with `UPDATE … SET balance = balance + :amount` is a second set of books by construction — not by misuse, by design. There is no configuration that makes it not one.

**The 25 controllers that reach `MemberWalletService` / `MemberTransaction`:**

| module             | controllers                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin` (12)       | `activity/Activity`, `businessAuth/BusinessCancelApply`, `ctc/AdminCtcOrder`, `finance/MemberTransaction`, `finance/WithdrawRecord`, `member/LegalWalletRecharge`, `member/LegalWalletWithdraw`, `member/Member`, `member/MemberWallet`, `otc/AdminAppeal`, `system/Coin`, `system/Dividend` |
| `ucenter` (10)     | `Activity`, `Approve`, `Asset`, `Ctc`, `LegalWalletWithdraw`, `Member`, `Promotion`, `RedEnvelope`, `Transfer`, `Withdraw`                                                                                                                                                                   |
| `otc-api` (2)      | `Advertise`, `Order`                                                                                                                                                                                                                                                                         |
| `exchange-api` (1) | `Order`                                                                                                                                                                                                                                                                                      |

**So the capabilities that MUST be rebuilt (or redirected) are:** spot order settlement (1), the OTC desk's escrow and release (3), CTC (4), fiat recharge/withdraw approval (5), crypto withdraw and transfer (6), balances themselves (7), dividend (15), and the reward/red-envelope/mining credit paths (12–14) if they are ever wanted.

**Two worked examples, so this is not abstract:**

- **OTC escrow.** `otc-api/…/OrderController` line 367 calls `memberWalletService.freezeBalance(wallet, amount)` to lock the seller's coin, and lines 532/544 `thawBalance` to unlock it. That is a hold. `svc-p2p` does the same thing through `packages/ledger-client` against `ledger.accounts` where `kind = 'hold'` — there are 17 such rows in our DB right now. **These are two implementations of one concept over two different books.** Adopting the vendored one means the escrow lock is invisible to the ledger, to reconciliation, and to the freeze/kill-switch.
- **Fiat recharge.** `ucenter-api/…/LegalWalletRechargeController` only writes a request row at `state = APPLYING` — no money moves. The money moves in `admin/…/member/LegalWalletRechargeController.pass()`, which calls `legalWalletRechargeService.pass(wallet, …)`. **That admin service is not running.** So today the vendored fiat rail can take an application and can never approve it.

**One caveat that cuts the other way:** the vendored app's precision is `decimal(18,8)`; ours is `numeric(38,18)`. Any value crossing that boundary truncates at the 8th decimal. The ADR flagged this and it is still true — it is arithmetic, and it applies under A, B and C alike.

### Bucket 2 — REBUILD IS WASTE

**Placement rule:** no `member_wallet` write, the vendored version works or is trivially startable, and the tracker either has nothing or has it at 🟢 (not started). Adopting these costs a container and some configuration; rebuilding them costs weeks.

| Capability                                        | Why it qualifies                                                                                                                                                                                       | What we would otherwise build            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **CMS** — announcements, help centre, whitepaper  | `admin/…/cms/{Advertise,Help}` + `system/Announcement` + `ucenter-api/…/{Announcement,Aide,Feedback}` + **7 finished `cms` screens**. Content only. Zero money references.                             | nothing — not in the tracker             |
| **Support chat**                                  | Whole `chat` module (`HistoryMessage`, `WebSocket`), jar already built. No money.                                                                                                                      | `ops.support` 🟢                         |
| **Statistics / finance reporting**                | `system/StatisticsController` (member, delegation, order, dashboard, order-rate) + `finance/{ExchangeTransaction,FinanceStatistics,MemberDepositRecord}`. **Reads only** — verified, no wallet writes. | `ops.analytics` 🟢                       |
| **Announcement / activity / help content model**  | `system/{DataDictionary,WebsiteInformation,AppRevision}` — configuration surfaces.                                                                                                                     | nothing                                  |
| **The 30 vendored screens as a design reference** | Already the accepted position in the UI ADR, already acted on: our own 11 screens live inside that shell.                                                                                              | re-drawing OTC/uc/cms flows from scratch |
| **Admin RBAC scaffolding**                        | `system/{Role,Permission,Employee,Department,AccessLog}` — a finished permission model. Reads/writes admin tables, not wallets.                                                                        | part of `ops.admin` 🟢                   |

**A caution that belongs in this bucket, not outside it:** "adopt" here means _run the module and use its output_. Every one of these still sits behind the vendored app's **session and CORS surface**, which `docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md` already rates P1–P4 (committed actuator basic-auth incl. `heapdump` on 6001/6006, MySQL root on the dev default at 5506, Mongo with no auth at all). Adopting the CMS does not mean adopting that perimeter unexamined.

### Bucket 3 — GENUINELY AMBIGUOUS

| Capability                                | Why it will not resolve on evidence                                                                                                                                                                                                                                                                                                                                                         | What would settle it                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity (8)**                          | The vendored app has a complete, running register/login/2FA/KYC stack. So do we, at ✅ across seven tracker rows. **But the shell already logs users into the Java `member` table**, so today identity is _de facto_ vendored on the surface and _de facto_ ours in the services. It is not money, so §0.6 does not decide it — and yet a user id is what every ledger account is keyed on. | **Owner call.** One question: does a person's account live in `identity.users` or in `member`? Everything else follows. There is no technical fact that answers it.    |
| **Market data (2)**                       | Vendored `market` answers today with seeded history; ours answers honestly-empty until a candle job exists (`trade.ccxt-api` note: _"ohlcv (route exists, always [] until candle aggregation job — no inventing candles)"_). One is complete and fake; one is incomplete and honest.                                                                                                        | Is a demo with synthetic candles acceptable, or must every number be real? That is a product/trust call, not an engineering one.                                       |
| **Admin console (17)**                    | 57 controllers + 92 Vue files, complete, never started — but **12 of the 57 write `member_wallet`**. The console is not separable from the money paths without reading it.                                                                                                                                                                                                                  | Read the 45 non-money admin controllers and confirm they are genuinely read-only. That is a day of work and it is worth doing **before** anyone decides.               |
| **Red envelope / mining / promo (12–14)** | Not in our tracker at all. They _do_ credit balances, so §0.6 puts them in bucket 1 — but "rebuild" presumes we want them. Nobody has said we do.                                                                                                                                                                                                                                           | Owner: are these products we want? If no, they are neither rebuild nor adopt — they are **delete**, and that is the cheapest outcome available in this whole document. |
| **Mobile apps**                           | `02_App_Android` and `03_APP_IOS` are in the tree. **Nobody has ever opened them** (the ADR's own "Not yet done" list). I will not guess at their state.                                                                                                                                                                                                                                    | Someone reads them. Until then any statement about them is invention.                                                                                                  |

---

## 6. The cost of getting it wrong — and why the two directions are not symmetric

### Direction 1 — we rebuild something the vendored app already does well

**Cost: time, and only time.** The wasted work is bounded and visible: a service that duplicates a CMS is a service nobody needed, and it can be deleted. Nothing is corrupted. No number becomes wrong. The loss is measured in agent-weeks.

**How much:** the seven "none-overlap" rows in §4 — CMS, chat, statistics, promotions, red envelope, mining, activity — represent perhaps 25 controllers and 20 screens of finished product. Rebuilding them from nothing is a large multiple of the cost of starting four containers.

### Direction 2 — we adopt something that writes `member_wallet` behind the ledger's back

**Cost: the platform's core guarantee, silently, and possibly irreversibly.**

Trace one adoption. Suppose we adopt the OTC desk because it is complete. A seller lists an advert; `OrderController` line 367 calls `freezeBalance`. Now:

1. `member_wallet.balance` drops and `frozen_balance` rises. **`ledger.accounts` does not move.** The ledger's sum-to-zero invariant still holds — it holds over a set of facts that no longer describes reality.
2. The hash-chained journal has no entry, so **replay reconciliation cannot detect the divergence**. It is not that reconciliation reports a mismatch; it is that reconciliation reports clean, because the event is not in the domain it reconciles over.
3. `svc-ledger`'s posting freeze and the operator kill-switches (`aff5d9f`) act on `ledger.*`. **They do not stop a Java `UPDATE`.** The kill-switch is live and the money still moves.
4. `custody-scan` does not read Java (§1), so **no gate fires** — not at commit, not in `pnpm verify`, not in CI.
5. `decimal(18,8)` vs `numeric(38,18)`: every amount that crosses truncates at the 8th decimal, so even a later reconciliation finds drift it cannot attribute.

**The asymmetry, stated plainly:**

|                         | Rebuild-when-we-should-adopt           | Adopt-when-we-should-rebuild                                     |
| ----------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| What is lost            | engineering time                       | the ability to say what a balance is                             |
| When you find out       | immediately — the duplicate is obvious | possibly never; there is no gate and no alarm                    |
| Reversible              | yes — delete the duplicate             | **no** — you cannot reconstruct a history that was never written |
| Bounded                 | yes                                    | no — grows with every transaction                                |
| Caught by `pnpm verify` | n/a                                    | **no**                                                           |

**A wrong rebuild costs weeks. A wrong adoption costs the property the entire architecture was built to have** — and `docs/POST-MERGE-RESIDUAL-AFTER-86.md` already lists "Real money still blocked by dual-book habit" as the floor. These are not two options on a spectrum. One is expensive; the other is the failure mode.

**The corollary the report must also say:** this asymmetry is an argument for _deciding_, not for paralysis. Refusing to adopt anything is itself a choice to pay direction-1 costs on all twenty capabilities — including the seven where there is no money argument at all.

---

## 7. Recommendation

> **This is a recommendation. The decision is the owner's, and the point of §1 is that it has not yet been made.**

**7.1 — Take the balance-ownership decision this week, in writing, as an ADR with `Status: Accepted`.** Not because B is better than C, but because eleven documents currently reference "dual-book" as an open risk and none of them can be closed until this one line exists. My reading of the evidence is that **Option B is already the de-facto position and nobody has said so**: our ledger has the rows, our services have the tests, `PROPER-CLEANUP-AFTER-DENON.md` T2-1 records the default as _"shell = UI, TS ledger = books"_, and the vendored `member_wallet` has never held a single row. **Option C's premise — that the vendored side has a book worth preserving — is not true here.** It has an empty table.

**7.2 — Split the vendored tree along the line the evidence already draws.** Not "adopt the app" or "rebuild the app", but:

- **Money paths (the 25 controllers in §5): do not adopt.** Rebuild in TypeScript against `packages/ledger-client`, which is largely what has been happening. This is not waste — it is the only correct answer under §0.6, and the vendored implementations have never processed a transaction, so nothing is being thrown away.
- **Non-money product (bucket 2): adopt, and add tracker entries for it.** CMS, support chat, statistics, RBAC scaffolding. Five of these have **no tracker row at all**, which is why they keep getting rebuilt by accident — an agent cannot avoid duplicating work that is not on the board.
- **The Vue shell: keep as the shell.** It already is one, it already hosts 11 of our screens, and the UI ADR's "port the screens, not the stack" is the right long-run call.

**7.3 — Close the two gaps that make a wrong adoption undetectable.** Both are small and neither prejudges the decision:

- Extend `custody-scan` to Java, or add the four `MemberWalletDao` mutators (`increaseBalance`, `decreaseBalance`, `freezeBalance`, `thawBalance`) to `vendor-shell-scan`'s FORBIDDEN list. Today the gate bans the exotic mint paths and permits the ordinary ones.
- Widen `decimal(18,8)` → `decimal(38,18)` anywhere value can cross, exactly as the ADR said on 28 July. This is required under A, B **and** C.

**7.4 — Ask the owner four questions that no amount of engineering can answer.** They are the entire content of bucket 3:

1. Does a user account live in `identity.users` or in `member`?
2. Are synthetic candles acceptable in a demo?
3. Do we want red envelopes, mining orders and promotion cards as products — or should they be deleted?
4. Who reads the mobile apps, and when?

**7.5 — What I would _not_ do:** start the vendored `admin` module to "see what it does". Twelve of its controllers write balances, its actuator ships committed basic-auth including `heapdump` (`A1.4`, P1), and `member_wallet` currently has zero rows — a state worth preserving until the decision in 7.1 exists.

---

## 8. Findings recorded, not fixed

Per the audit brief — written down, no code touched.

| #   | Finding                                                                                                                                                                                                                                                                            | Severity                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| F1  | **`custody-scan` walks `['.ts','.tsx']` only** (`tooling/ci/custody-scan.mjs:80`). The doctrine gate for "no module holds its own balance" cannot see the module that holds its own balance.                                                                                       | High — a gate that reads clean    |
| F2  | **`vendor-shell-scan` bans 7 exotic mint patterns and permits the 4 ordinary mutators** in `MemberWalletDao`, which is what all 25 money controllers actually call.                                                                                                                | High — same shape as F1           |
| F3  | **The ADR's balance-ownership decision is still `Status: In progress` two days on**, while eleven documents treat "dual-book" as a known open risk.                                                                                                                                | High — blocks everything else     |
| F4  | **The vendored OTC desk runs with `otc_coin` empty**, so every advert route refuses `validate otcCoin unit!`. A live service that cannot serve its core request.                                                                                                                   | Medium — misleading if demoed     |
| F5  | **`market` serves seeded synthetic candles with `volume: 0.0000`**, and the seeder's own header says thumbnails decay toward zero at 00:00 UTC unless re-run daily. Anything screenshotting 6004 is screenshotting a fixture.                                                      | Medium — demo-honesty risk        |
| F6  | **The admin module (57 of 94 controllers) has never started**, so every vendored approval step — fiat pass, withdraw approval, appeal release — is unreachable. Any claim that fiat rails "already work" is false today.                                                           | Medium — corrects a premise       |
| F7  | **`intafaced-shell-web` is in neither compose file.** It is hand-started, bind-mounted from the main checkout at `05_Web_Front`, with `node_modules` bind-mounted from a _different worktree_ (`feat-upstream-exchange-integration`). It will break when that worktree is removed. | Medium — undeclared dependency    |
| F8  | **`identity.users` grew by ~87 rows during this audit** (7,105 → 7,192) against the shared dev database. Same pollution that breaks `svc-identity`'s KYC test.                                                                                                                     | Low — known, noted for the record |
| F9  | Five vendored capabilities with **no tracker row at all** (CMS, red envelope, activity/sign-in, support chat content, mining orders) — the reason duplicate work keeps being started.                                                                                              | Low — process                     |

---

## Method

Everything above was probed or read on 2026-07-30 against `main` @ `207c8a6`:

- `docker ps` for the running fleet; `docker logs` for the two silent modules.
- `curl` against 6001, 6003, 6004, 6006 — with the `server.context-path` prefixes (`/uc`, `/exchange`, `/market`, `/otc`) from each module's `dev/application.properties`; without them all four return a bare 404, which is how "these are down" gets reported by mistake.
- `mysql` against `upstream` on 5506 and `psql` against `intafaced` on 5433 for exact `count(*)` — not `information_schema.table_rows`, which is an InnoDB estimate.
- `find` / `grep` over 108 controller files and 1,105 vendored source files.
- `git log --all --grep` and `git log --all -- docs/adr/` for the decision search.
- `node tooling/ci/vendor-shell-scan.mjs` and `node tooling/ci/brand-scan.mjs` — both clean.

Where I could not tell, §3.4, §5 and bucket 3 say so.

## Links

- The undecided decision: [`docs/adr/2026-07-28-vendored-exchange-integration.md`](adr/2026-07-28-vendored-exchange-integration.md) §"THE decision that has to be made"
- The UI position (settled): [`docs/adr/2026-07-28-vendored-exchange-ui.md`](adr/2026-07-28-vendored-exchange-ui.md)
- Open risk queue: [`docs/POST-MERGE-RESIDUAL-AFTER-86.md`](POST-MERGE-RESIDUAL-AFTER-86.md) item 1
- The owner-decision that was filed and never answered: [`docs/PROPER-CLEANUP-AFTER-DENON.md`](PROPER-CLEANUP-AFTER-DENON.md) T2-1
- Perimeter on the vendored ports: [`docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md`](A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md)
- Shell honesty rules already in force: [`docs/STREAM-A-PHASE1-PLAN.md`](STREAM-A-PHASE1-PLAN.md)
- Doctrine: §0.6, §4.2 of [`INTAFACED_DEFINITIVE_BUILD.md`](../INTAFACED_DEFINITIVE_BUILD.md)
