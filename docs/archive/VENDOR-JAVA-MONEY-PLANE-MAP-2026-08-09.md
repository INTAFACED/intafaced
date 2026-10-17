# Vendor Java money plane map — where value can move, and what stops it

**Board item:** D26-P4 · Denon lane. **Read-only audit** — no Java file is edited by this branch, no build is added.
**Date:** 2026-08-09. **Tree:** `vendor/upstream-exchange/` at `2d85e546`.
**Superseding executable proof (D26-P2-02):** [`VENDOR-JAVA-MONEY-PLANE-MAP-D26-P2-02.md`](VENDOR-JAVA-MONEY-PLANE-MAP-D26-P2-02.md) — re-run with `pnpm map:vendor-java-money-plane`. Tip numbers (door count, ratchet, `/promotion` + `/monitor` fragments, `exchange` door) live there; this narrative stays for depth.
**Builds on:** ADR [`2026-08-04-java-dual-book-residual.md`](adr/2026-08-04-java-dual-book-residual.md) (D-S-17), `DIRECTION` §4, and the five gates named in §2. It does not re-litigate Option B.

---

## 0 · How to use this map

One question, per app. Find your row, then read the named section.

| Where                        | Can value move?                            | What stops it                                                  | §   |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------------------- | --- |
| `admin`                      | yes — HTTP + 2 scheduled jobs              | service throw · 410 door (never executed — no compose service) | 3.1 |
| `ucenter-api`                | yes — HTTP                                 | service throw · 410 door · **one HTTP path with door gap**     | 3.2 |
| `otc-api`                    | yes — HTTP                                 | service throw · 410 door (module cannot boot)                  | 3.3 |
| `exchange-api`               | yes — HTTP order placement                 | service throw · 410 door                                       | 3.4 |
| `market`                     | **yes — Kafka settlement executor**        | service throw **only**. No door reaches it, by construction    | 4.1 |
| `wallet`                     | **yes — deposits + real on-chain sends**   | service throw for the book; **nothing for the chain send**     | 4.2 |
| `exchange`                   | indirect — HTTP triggers settlement topics | nothing in-module; terminates in the `market` service throw    | 4.3 |
| `chat`, `cloud`, job module  | no                                         | n/a — no value surface                                         | 4.4 |
| `01_wallet_rpc` (13 daemons) | **yes — real on-chain value, 6 modules**   | one shared static token; **4 cron spenders behind no token**   | 5   |

The short version: **the dual-book controls are strong on the second book and silent on the chain.** Every mechanism in §2 governs writes to `member_wallet`. None of them governs a wallet RPC daemon sending real coin, and one path in `wallet` reaches such a send with no dual-book control in front of it (§4.2, §7.1).

---

## 1 · Scope and vocabulary

- **"Second book"** = the upstream `member_wallet` table and its `balance` / `frozen_balance` / `to_released` columns. Doctrine §0.6: one book, in `packages/ledger-client`; `member_wallet` is a read-only projection.
- **"Network door"** = reachable from an HTTP request to that module's own port.
- **"Internal caller"** = reachable only from a Kafka consumer, a Spring event listener, a `@Scheduled` method, or another bean.
- Modules are named `module:Class.java`, and package paths are elided as `…`. This is the convention the scan allowlist and the ADR already use, and it is required: `brand-scan` bans the upstream identity in `docs/` prose, so a full package path cannot be written here.

---

## 2 · The controls, and what they actually print today

Five gates govern this tree. **Three figures in the D26-P4 brief are stale**; these are the outputs of the runs I performed on this branch.

| Gate                       | Prints today                                                                                                                                                            | Brief said                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `vendor-java-money-scan`   | 870 Java files, **9** live-write patterns + **3** second-book shapes, 4 DAO mutators proved no-op, **47** writes ratcheted across **21** files, 26 test sources skipped | 8 + 2 patterns, 55 across 26 files |
| `dual-book-door-scan`      | interceptor + registration on `admin`, `ucenter-api`, `otc-api`, `exchange-api`                                                                                         | same                               |
| `dual-book-door-path-unit` | 40 fragments, 11 block + 5 allow fixtures                                                                                                                               | same                               |
| `wallet-rpc-mainnet-scan`  | 16 modules, 229 Java + 13 properties files, 57 frozen constants, 47 rule probes (29 fired / 18 silent), barriers held                                                   | same                               |
| `wallet-rpc-auth-scan`     | 12 of 13 PROVE a perimeter; `act` **RECORDED UNPROVEN**; 4 frozen findings                                                                                              | same                               |
| `gates.mjs`                | **✓ all 32 doctrine gates passed**                                                                                                                                      | 31 gates                           |

The ratchet moved because work landed: the scan gained the `to_released` rules, and Grade D plus several Grade C sites were deleted rather than disabled. **The direction of travel is real and it is the right direction.** I flag the drift only because a map that quotes a superseded number teaches the wrong figure, and the brief's own instruction was to say so with evidence rather than adopt it.

The ADR's own table (63 sites / 29 files) is likewise superseded by the same work. Reconciliation against the live allowlist:

| Grade                         | ADR 2026-08-04 | Live today | Note                                                                  |
| ----------------------------- | -------------- | ---------- | --------------------------------------------------------------------- |
| A — DAO no-op + service throw | 7              | 7          | unchanged; re-proved every run                                        |
| B — service throws            | 29             | 29         | unchanged                                                             |
| C — 410 door only             | 12             | **4**      | 8 retired; `admin:MemberWalletController` / `DividendController` gone |
| D — held by nothing           | 10             | **0**      | deleted outright, as the ADR required. Heading kept, empty            |
| — not balance writes          | 5              | 7          | zero-init sites, listed rather than pattern-excluded                  |
| **Total**                     | **63**         | **47**     |                                                                       |

Grade D being empty is the single most important improvement since the ADR, and it is verified: the ratchet fails if an entry reappears under that heading.

---

## 3 · The money plane — `00_framework`, the four doored apps

All four register `DualBookMoneyDoorInterceptor` on `/**` (verified by `dual-book-door-scan`, which asserts the registration statement and not merely the import). The interceptor refuses 40 URI fragments with HTTP 410, matching against the **decoded, lower-cased** path, re-decoded up to three times so a nested percent-encoding cannot skip it once.

### 3.1 `admin`

| Path                                      | Reachable from                   | Stopped by                          |
| ----------------------------------------- | -------------------------------- | ----------------------------------- |
| `admin:ActivityController.java` (3 sites) | network door                     | service throw + door                |
| `admin:AdminCtcOrderController.java` (2)  | network door                     | service throw + door                |
| `admin:AdminAppealController.java` (1)    | network door                     | service throw + door                |
| `admin:CheckRedEnvelopeJob.java` (2)      | **`@Scheduled` — internal only** | **service throw only**              |
| `admin:CheckCtcOrderJob.java` (1)         | **`@Scheduled` — internal only** | **service throw only**              |
| `admin:CoinController.java` (1)           | network door                     | not a wallet — hot-transfer log row |
| `admin:ForkJoinWork.java` (2)             | internal                         | zero-init of new wallets            |

**The door has never executed in this module.** `admin` has no service in `vendor/upstream-exchange-compose.yml` (verified: the compose services are `cloud`, `exchange`, `market`, `ucenter`, `exchange-api`, `otc`). The ADR made this point and it still holds. The two job classes are the honest cases: a `@Scheduled` method is unreachable from an HTTP interceptor at all, so the service throw is the whole control.

### 3.2 `ucenter-api`

| Path                                         | Reachable from | Stopped by                                |
| -------------------------------------------- | -------------- | ----------------------------------------- |
| `ucenter-api:WithdrawController.java` (1)    | network door   | service throw + door                      |
| `ucenter-api:CtcController.java` (2)         | network door   | service throw + door                      |
| `ucenter-api:ApproveController.java` (2)     | network door   | **410 door only** (Grade C)               |
| `ucenter-api:RedEnvelopeController.java` (2) | network door   | **410 door only** (Grade C)               |
| `ucenter-api:PromotionController.java` (1)   | network door   | **service throw only — no door fragment** |

**The door gap.** `PromotionController` maps `/promotion`, and its `/promotion/promotioncard/exchangecard` handler calls `memberWalletService.increaseFrozen(...)` at line 480. No fragment in the 40-item block list matches `/promotion`. The call throws, so nothing moves — but this site is held by **one** mechanism where the doored sites have two, and it is **not counted in the 47**, because `increaseFrozen` is not one of the four names the ratchet matches (§6.2).

The two Grade C entries are the sites where the door is genuinely load-bearing: `ApproveController` freezes a business-auth deposit and `RedEnvelopeController` credits an envelope claim, both by Hibernate managed-entity mutation, and neither goes through a throwing service method. `ucenter` **is** in compose, so unlike `admin` these two 410s can actually execute.

### 3.3 `otc-api`

`otc-api:OrderController.java` (3 sites) and `otc-api:AdvertiseController.java` (2) — OTC order and advert lifecycle. Network door; service throw + door.

`otc-api` is in compose but **cannot boot** — three documented defects, one deliberately not worked around because the workaround would mean committing an unverifiable jar onto a money service's classpath. That reasoning is right and stays. The practical effect is the same as `admin`: the door is wired and has not run.

### 3.4 `exchange-api`

Door fragment `/order/add` covers order placement. The module's own balance-write inventory is empty — the trading-path writes live in `exchange-core:ExchangeOrderService.java`, which `exchange-api` calls into. See §4.1: that class is reached far more often over Kafka than over HTTP, which is why the door is the weaker half of its protection.

---

## 4 · The money plane — `00_framework`, the six undoored apps

`00_framework` has **ten** `@SpringBootApplication` classes, not four. Six register no money door. Two of those six move value.

### 4.1 `market` — the spot settlement executor

This module's name is misleading. It is not a read-only quote service; it is where spot trades settle.

`market:ExchangeTradeConsumer.java` holds five `@KafkaListener` methods, three of which reach the trading-path money code in `exchange-core:ExchangeOrderService.java`:

| Listener                        | Line | Calls                       | Reaches                                |
| ------------------------------- | ---- | --------------------------- | -------------------------------------- |
| `exchange-trade`                | :56  | `processExchangeTrade` :173 | `increaseBalance` ×3 + referral payout |
| `exchange-order-completed`      | :64  | `tradeCompleted` :74        | `orderRefund` → `thawBalance`          |
| `exchange-order-cancel-success` | :137 | `cancelOrder` :146          | `orderRefund` → `thawBalance`          |

The eight ratcheted sites in `exchange-core:ExchangeOrderService.java` are at lines **113, 126, 378, 472, 502, 619, 746, 755** — I verified each one individually (§8). All eight call `memberWalletService`, never the DAO, so all eight throw. Line 444 is a commented-out `increaseBalance` and is correctly excluded by the scan's tokeniser rather than counted.

**What stops it: the service throw, and nothing else.** `market` registers no interceptor — its `market:ContextConfig.java` extends the Spring MVC configurer but contributes CORS only. This is not an oversight to be fixed by adding a door: **an HTTP interceptor cannot guard a Kafka consumer.** The ADR says this plainly and it is the single most important structural fact on this page. `market` is in compose, so this is the largest money seam that is both deployed and held by exactly one mechanism.

Two properties of the consumer worth recording because they matter if the throw were ever lifted: the refund amounts at :74 and :146 are taken straight off the Kafka payload rather than recomputed, and the consumer group is the shared default. Anything that can publish to those topics names its own refund amount.

`market` also runs eight `@Scheduled` methods. Seven are K-line/push/rate work with no value movement. One, `market:CoinExchangeRate.java`, scrapes a USDT/CNY price from third-party public endpoints every 5 minutes and a forex rate every 30 minutes, and that rate feeds a public read endpoint. No value moves, but it is a third-party input on a price surface, and one of those calls carries a committed third-party API credential — that is a `secret-scan` matter for the rotation readiness lane, not a money-plane finding, and it is deliberately not reproduced here.

### 4.2 `wallet` — deposits, and the one real gap

`wallet:FinanceConsumer.java` is the deposit/withdraw executor. Three Kafka listeners:

| Listener          | Line | Calls                                              | Stopped by          |
| ----------------- | ---- | -------------------------------------------------- | ------------------- |
| `deposit`         | :47  | `recharge2` :69 / `recharge` :74                   | **service throw** ✓ |
| `withdraw`        | :85  | `/rpc/withdraw` :101 → then `withdrawSuccess` :109 | **see below** ✗     |
| `withdraw-notify` | :130 | `withdrawSuccess` :149 / status reopen :146        | service throw ✓     |

Deposit crediting is dead: `recharge(MemberWallet, BigDecimal)`, `recharge(Coin, String, BigDecimal, String)` and `recharge2(...)` all throw `IllegalStateException` (verified at `core:MemberWalletService.java` :86, :101, :115). `withdrawSuccess` and `withdrawFail` throw too (`core:WithdrawRecordService.java` :133, :144).

**The gap is the ordering in `handleWithdraw`.** The sequence is:

1. :101 — `restTemplate.getForObject("http://SERVICE-RPC-{COIN}/rpc/withdraw?address=…&amount=…&fee=…")`. **This is the real on-chain send.** The amount comes off the Kafka payload; the target service name is interpolated from the record key.
2. :109 — `withdrawRecordService.withdrawSuccess(withdrawId, txid)` — throws.
3. The throw is caught by the method's own `catch (Exception e)` and routed to `autoWithdrawFail(withdrawId)`, which only flips two status flags to "manual processing" (verified: `core:WithdrawRecordService.java` :154-166 contains no value movement).

So the dual-book control fires **after** the coin has left, and its exception is swallowed by an upstream catch block that logs "auto transfer failed, switch to manual". Net effect if this code ran: **funds leave the chain, the book records nothing, and the record is marked as needing a manual retry** — which is a double-payout shape, not merely a missing credit.

**What actually stops it today: `wallet` has no compose service.** That is deployment absence, not a control. It is also the only thing standing there. Two further notes: `wallet:MemberConsumer.java` :65-72 rewrites an existing wallet's deposit address from an RPC response keyed on an unauthenticated payload field — an attribution surface, not a balance write, and covered by no rule; and `wallet:CoinConsumer.java` writes new wallets through a direct `EntityManager` `persist`/`flush`, bypassing the service layer. Both are zero-value today. The `EntityManager` route is worth knowing exists, because every control in §2 assumes writes arrive through a DAO or a managed-entity setter.

The module's only controller is a test controller on `/test` whose two handlers make service-name-interpolated outbound calls from a path variable. It declares no `spring-boot-starter-web` directly; whether a port opens depends on transitive resolution, which I did not resolve and will not claim either way.

### 4.3 `exchange` — HTTP that reaches settlement one hop away

`exchange:MonitorController.java` maps `/monitor` with **12 handlers declared as `@RequestMapping`**, so each answers every HTTP verb. The module registers no interceptor (`exchange:CorsConfig.java` sets CORS only).

Two of those handlers publish to a settlement topic:

- `/monitor/reset-trader` → `kafkaTemplate.send("exchange-order-completed", …)` at :220
- `/monitor/start-trader` → the same send at :283

`market` consumes `exchange-order-completed` at :64 and calls `tradeCompleted` → `orderRefund` → `thawBalance`. **Verified end to end.** So an unauthenticated request to `exchange` can drive the settlement pipeline in a different service until it terminates in the `market` service throw.

This one is squarely in scope for the existing mechanism: it is HTTP, it is money-adjacent, and `exchange` is in compose. It is the clearest candidate for either a door registration or an auth requirement, and it is the only finding on this page where the standard fix applies without redesign.

### 4.4 `chat`, `cloud`, and the job module — no value surface

- **`chat`** — two endpoints, neither money. No JPA, no wallet service. It registers a member interceptor on `/chat/**`, a pattern that matches neither of its actual endpoints; that is an auth gap, not a money one.
- **`cloud`** — service registry. Five event listeners, two of which send administrative email. No value.
- **the job module** (`00_framework/…-job`) — one Java file. `@EnableScheduling` is on and there is not a single `@Scheduled` method on its classpath, so the scheduler starts with an empty registry. It opens a port and serves one inherited captcha endpoint. Zero money surface and no reason to run.

---

## 5 · The money plane — `01_wallet_rpc`

Thirteen Spring Boot daemons that hold withdrawal keys. **This is the only part of the tree where value can move for real**, because these processes talk to chains rather than to a database.

Nothing in §2's dual-book apparatus applies here. `member_wallet` is not involved. What governs this tree instead is `wallet-rpc-auth-scan` (perimeter), `wallet-rpc-mainnet-scan` (frozen constants + build barriers), and the owner gate.

### 5.1 What moves value

| Module                  | Value-moving endpoints                                         | Cron spender                           |
| ----------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `bitcoin`               | `GET /rpc/transfer`, `/rpc/withdraw` → node send               | —                                      |
| `ect`                   | `GET /rpc/transfer`, `/rpc/withdraw` → `sendFrom`              | —                                      |
| `usdt`                  | `/rpc/withdraw`, `/rpc/transfer`, `/rpc/transfer-from-address` | **every 2h** — miner-fee top-ups       |
| `eth`                   | `/rpc/transfer` (mass sweep), `/rpc/withdraw`                  | balance sync only                      |
| `erc-token`             | `/rpc/transfer-from-address`, `/rpc/transfer`, `/rpc/withdraw` | **cron** — gas top-ups                 |
| `erc-eusdt`             | same three (controller is byte-identical to `erc-token`)       | **hourly** — gas top-ups               |
| `bch`,`bsv`,`btm`,`ltc` | stubs returning 500 "not implemented"                          | —                                      |
| `eos`                   | controller declares no handlers                                | —                                      |
| `xmr`                   | height query only                                              | —                                      |
| `act`                   | height + address-mint; **no send path**                        | —                                      |
| `eth-support` (shared)  | —                                                              | **every 30s** — drains a payment queue |

I verified by direct read: `usdt`'s `/rpc/withdraw` performs a send with **no amount validation at all** (no `> 0` check, unlike `bitcoin` and `ect`); `eth`'s `/rpc/transfer` sweeps to a **caller-supplied destination address**; and the three cron spenders' schedules and send calls. The `act` duplicate-version finding I verified line by line (§5.3).

Two shapes deserve naming because they are worse than "an endpoint that sends money":

- **`/rpc/transfer` on `eth`, `erc-token`, `erc-eusdt`, `usdt` is a mass sweep**, not a single payment: it iterates every stored deposit account and sends balances to an address the caller names.
- **`/rpc/transfer-from-address` moves funds out of an arbitrary caller-named source.** In `usdt` it computes an available-amount clamp and then sends the raw requested amount anyway — the clamp is discarded. That is a live bug in a spend path, not a hardening opportunity.

### 5.2 What stops it

**One static shared secret.** `RpcAuthInterceptor` compares a single header constant-time and returns 401 otherwise; `RpcSecurityConfig` registers it on `/**` and refuses to start if the token is blank or under 32 characters. Where it is present, coverage is total — no excludes, no health carve-out.

What it is not: no IP allowlist, no request signature, no per-endpoint authorisation, no amount cap, no idempotency key, no rate limit. One token is full withdrawal authority on every module. Every value-moving endpoint is a `GET` with query parameters, so amounts and destinations land in access logs and a leaked token is replayable.

An inversion worth stating: the six modules carrying their **own** copy of the config (`bch`, `bsv`, `btm`, `eos`, `ltc`, `xmr`) are exactly the ones whose withdraw handlers are stubs or absent. **Every module that actually spends inherits the guard through a jar boundary** — either a direct `rpc-common` dependency (`bitcoin`, `ect`, `usdt`) or transitively via `eth-support` (`eth`, `erc-token`, `erc-eusdt`). That inheritance works because the shared config's package sits under the apps' component-scan root, which is a package-naming coincidence asserted by nothing in the build.

**The four cron spenders are outside the perimeter entirely.** An HTTP interceptor is irrelevant to a `@Scheduled` method. They send real funds with no token, no cap, and no kill switch reachable from source. This is the wallet-RPC analogue of the `market` finding in §4.1, and it is the same lesson: the guard is on the door, and the money also comes through the floor.

No test anywhere in the tree asserts the 401, and surefire is skipped in the module poms.

### 5.3 `act` — F10, and what it is honestly worth

`act/pom.xml` declares `rpc-common` **twice**: version `1.0` at line 52 and version `1.2` at line 80, forty lines apart. Verified by direct read. This reactor builds `1.2`; no `1.0` exists anywhere in the tree. Maven resolves the first declaration for a duplicate coordinate and says nothing about the second, so:

- if `1.2` wins, `act` is covered like `bitcoin`;
- if `1.0` wins and a stale local artifact predating the auth work satisfies it, that jar carries no config, nothing reads the token property, and **an unresolved `${…}` placeholder that no bean reads does not stop startup** — `act` boots with no interceptor and no error;
- if `1.0` wins and nothing satisfies it, the build fails.

Which one happens is a resolver-order fact, not a source fact. That is why the gate records it as **RECORDED UNPROVEN** rather than green, and why the fix is an owner action: the edit is inside unreviewed key-handling third-party code.

**The honest sizing, in both directions.** `act` is the weakest-proven perimeter in the tree _and_ the module with the least behind it: it has no send path at all. Its exposure if unauthenticated is a height query plus an address-minting handler that answers any HTTP verb — a deposit-attribution and enumeration surface, not a withdrawal. So F10 is LIVE as a **proof** failure and small as a **value** failure, and it must not be cited as evidence that the perimeter model works on the six modules that do spend.

---

## 6 · Coverage boundaries, stated as boundaries

### 6.1 The 26 skipped test sources — answered: no

`vendor-java-money-scan` skips `**/src/test/**` so a test can name a mutator to assert it throws. I enumerated all 26 and grepped every one for money vocabulary. **Two hits, both benign:**

- `admin:WebApplicationTest.java` :238 calls `withdrawRecordService.test()`. I read that method: it is a read-only paging query (`core:WithdrawRecordService.java` :95-109). No value.
- `eth-support:PaymentHandlerEip155Test.java` — known-answer fixtures for EIP-155 withdrawal **signing**. It asserts signature correctness; it broadcasts nothing.

No value movement lives in the skipped set. This boundary is currently costing nothing.

### 6.2 The DAO positive assertion covers 4 of 15 — this is the real hole

Check 2 exists because check 1 cannot catch a re-arm phrased differently from upstream. The scan's own header says so: `UPDATE member_wallet SET balance = :newBalance` "writes the second book and matches none of the eight," so the four mutator declarations "are asserted POSITIVELY instead."

**`MemberWalletDao.java` carries 15 no-op'd `@Modifying` declarations, not 4.** All 15 currently hold the sanctioned `UPDATE member_wallet SET id = id WHERE 1 = 0`. Check 2 positively asserts only the four in `WALLET_MUTATORS`. The other eleven — `decreaseFrozen`, `increaseFrozen`, `unfreezeLess`, `createWeekTable`, `updateTeamWallet`, `updateMemberWalletByMemberIdAndCoinId` (×2 overloads), `updateByMemberIdAndCoinId`, `increaseBalanceForBHB`, `updateBalanceByIdAndAmount` — are held **only** by check 1's text patterns.

I tested this rather than asserting it. Running the scan's own nine SQL regexes and three code regexes against candidate re-arm strings:

| Candidate re-arm                                                             | Caught? |
| ---------------------------------------------------------------------------- | ------- |
| `UPDATE member_wallet SET balance = :balance WHERE …`                        | **no**  |
| `UPDATE member_wallet SET frozen_balance = :f, balance = :b WHERE …`         | **no**  |
| `UPDATE member_wallet SET balance = balance * 2 WHERE 1 = 1`                 | **no**  |
| service body delegating to `memberWalletDao.updateByMemberIdAndCoinId(…)`    | **no**  |
| `UPDATE member_wallet SET balance = balance + :amount …` (upstream phrasing) | yes     |

Only the literal upstream phrasing is caught. The absolute-assignment shape — which is precisely the signature of these eleven methods, three of which take a `balance`/`allBalance` parameter — is invisible to every rule in the scan.

The concrete re-arm is two edits in two files, both green: restore the `@Query` on `updateByMemberIdAndCoinId` to an absolute set, and restore the service body to delegate to it. Neither edit trips check 1 (wrong text shape), check 2 (wrong method name), check 3 (name not in the banned four) or check 4 (no setter involved).

**Mitigating facts, stated so this is not read as larger than it is:** all 15 are no-op today; all 15 service wrappers throw today (I read every one); and a re-arm phrased through a managed-entity setter _would_ be caught, because `MemberWalletService` holds no budget for the setter rule. The gap is specific — a DAO-routed, absolute-assignment re-arm — and it is real.

### 6.3 The door covers four apps of ten

`00_framework` has ten Spring Boot apps. Six register no money door, and **two of those six move value** (§4.1, §4.2). A third (`exchange`, §4.3) has unauthenticated HTTP that reaches a settlement topic.

The important distinction is between _unprotected_ and _unprotectable_:

- **`exchange` is unprotected.** Its money-adjacent surface is HTTP. The existing mechanism fits.
- **`market` and `wallet` are unprotectable by this mechanism.** Their money surface is `@KafkaListener` and `@Scheduled`. No door registration on any number of apps reaches them. The only chokepoint both share is the service layer, which is exactly where the throws already are — so the current control is the right one, and the door count is simply not the measure of coverage here.

There are also six `ApplicationConfig.java` files, not four; `chat` has one and registers an unrelated interceptor. `dual-book-door-scan` requires the door on four named modules and would not notice a seventh app appearing with a money controller. That is a ratchet the door scan does not have and the money scan does.

### 6.4 The 47 ratcheted writes are frozen, not fixed — which would matter if the door opened

Zero of the 47 are redirected to `packages/ledger-client`. Every allowlist entry names a target recipe; none is implemented. Ranked by what would happen if the throws were lifted:

| Site                                                    | If the throw were lifted                                                                                | Priority |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| `exchange-core:ExchangeOrderService` (8)                | The trading path double-books every fill, freeze and refund. Deployed via `market`, reached over Kafka. | **1**    |
| `ucenter-api:ApproveController` (2)                     | Live freeze — held by the door alone, and `ucenter` is in compose so the door does run                  | **2**    |
| `ucenter-api:RedEnvelopeController` (2)                 | Live credit — same posture                                                                              | **2**    |
| `admin:CheckRedEnvelopeJob` (2), `CheckCtcOrderJob` (1) | Timer-driven refunds with no door, ever                                                                 | **3**    |
| `otc-api` + `admin` OTC/CTC controllers (13)            | Escrow double-book, but on modules that cannot boot                                                     | 4        |
| `ucenter-api:PromotionController` (1, uncounted)        | Live freeze, single mechanism, no door                                                                  | 4        |
| Zero-init sites (7)                                     | Nothing — they construct new wallets                                                                    | —        |

The two Grade C entries are the sharp end: they are the only sites whose sole control is a door that actually executes, so they are the only ones where a fragment-list mistake is directly a money bug. The `dual-book-door-path-unit` fixtures (11 block, 5 allow) are what make that list a tested artifact rather than a comment.

### 6.5 `act` / F10 — LIVE

Stated in full at §5.3. The gate's summary line names `act` as unproven, so a green run cannot be misread as "all thirteen authenticate". The four frozen pom findings are exact-text baselines that can only shrink.

---

## 7 · What is claimed but unverifiable — the reason this is a Denon lane

### 7.1 The standing position, and where it is weaker than documented

The repo's position is _"the Java money paths are killed at the door and its mutators proved no-op."_ Testing that sentence against the tree:

**Where it holds, and holds well.** The second book is genuinely hard to write. Fifteen DAO declarations are no-op, fifteen service methods throw, the four highest-traffic mutators are positively re-asserted on every run, the door's registration is proved rather than its import, the path list is unit-tested, and Grade D — the class the ADR called "held by nothing" — is empty and ratcheted to stay empty. The last is real, verified progress against a named commitment.

**Three places where the sentence claims more than the tree supports.**

1. **"Killed at the door" is true of four apps and irrelevant to the two biggest movers.** `market` settles spot trades from Kafka and `wallet` executes deposits and withdrawals from Kafka. Neither has, or can have, a door. The controls that hold there are the service throws. The ADR says this; the summary sentence does not, and the sentence is what gets repeated.

2. **The mutator scan governs the book, not the chain.** `wallet:FinanceConsumer` :101 sends real coin to a wallet RPC daemon **before** the dual-book control is reached, and the resulting exception is swallowed into a "switch to manual" status flip. No gate in §2 covers that call, because no `member_wallet` write happens on that line. The only thing standing there today is that `wallet` has no compose service — deployment absence, not a control. **This is the one place I would say the standing position is materially weaker than documented.**

3. **"Proved no-op" covers 4 of 15 DAO declarations.** §6.2, with an executed test rather than a reading.

Everything else I checked matched its documentation, and in two cases (Grade D, Grade C count) the tree is _better_ than the ADR describes.

### 7.2 Proved by a run vs proved by a read

The brief's central question. `vendor/**` has no blocking compile in CI, so most "this is dead" claims rest on reading.

**Proved by a run:**

| Claim                                                                     | The run                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 4 DAO mutators carry the sanctioned no-op                                 | `vendor-java-money-scan` check 2, no allowlist, every run            |
| No live upstream-phrased SQL balance write exists                         | check 1, 9 patterns                                                  |
| No new setter/`to_released` write beyond 47 in 21 files                   | checks 3-4 ratchet, both directions                                  |
| The door is _registered_, not merely imported                             | `dual-book-door-scan`                                                |
| The 40 fragments block what they claim and allow what they should         | `dual-book-door-path-unit`, 16 fixtures                              |
| 57 mainnet constants unchanged; nothing builds/boots `01_wallet_rpc`      | `wallet-rpc-mainnet-scan`, incl. 47 rule probes                      |
| 12 of 13 RPC modules have the guard on the classpath at the built version | `wallet-rpc-auth-scan`                                               |
| The absolute-assignment re-arm is uncaught (§6.2)                         | my probe of the scan's own regexes                                   |
| **`00_framework/core` compiles under the pinned toolchain**               | `.github/workflows/vendor-compile.yml` — 12 recent runs, all success |

**Proved by a read only — and load-bearing:**

| Claim                                                          | Why a read could be wrong                                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All 29 Grade B call sites are dead because the service throws  | Depends on every call reaching `memberWalletService` and on no subclass or proxy overriding it. I confirmed the receiver on all 8 trading-path sites; the other 21 I confirmed by receiver name only |
| The 11 unasserted DAO declarations are no-op                   | True today by reading. Nothing re-proves it (§6.2)                                                                                                                                                   |
| The 15 service methods throw                                   | Read all 15. Nothing asserts they keep throwing                                                                                                                                                      |
| The Kafka/`@Scheduled` money paths are unreachable in practice | Rests on `wallet` and `admin` having no compose service — a deployment fact that a compose edit changes silently                                                                                     |
| `act` boots with a guard                                       | **Cannot** be proved by reading. Resolver-order fact (§5.3)                                                                                                                                          |
| A port opens on `wallet`                                       | Depends on transitive resolution I did not perform. I claim nothing                                                                                                                                  |

**The compile-barrier claim needs one correction, in the tree's favour.** The brief states vendored Java "is not compiled by CI (there are barrier checks proving no Dockerfile, compose file or workflow builds this tree)". Both halves need qualifying:

- A **compile probe now exists** — `.github/workflows/vendor-compile.yml` runs `mvn -pl core -am -DskipTests compile` under the pinned JDK 8 / Maven 3.8 image on PRs touching `vendor/**`. I checked its run history: **12 recent runs, all success.** So the ADR's finding that `core` could not compile is **resolved and continuously re-proved**, which is a genuine strengthening of the Grade A controls, since `core` is where `MemberWalletDao` and `MemberWalletService` live.
- But it is `continue-on-error: true` and **advisory** — a red compile never blocks a merge — and it builds **`core` and its dependencies only**. `exchange-core`, `admin`, `ucenter-api`, `otc-api`, `market` and `wallet` are not compiled. So the eight trading-path Grade B sites, and every Grade C site, still have **no** compile proof.
- The barrier claim itself is accurate and correctly scoped: `wallet-rpc-mainnet-scan`'s "none builds, composes or boots this tree" means **`01_wallet_rpc`**, and its M7 check explicitly carves out a framework-only compile probe while failing on any Maven invocation that touches the wallet RPC tree. The phrase "this tree" is easy to over-read as the whole vendor directory; it is not that, and it does not claim to be.

The ADR's deeper point survives all of this intact: **compose runs prebuilt, gitignored jars, and no scan can tie a source claim to those artifacts.** A green source gate plus a green advisory compile of one module is still not evidence about the running binary.

### 7.3 Where a read could plausibly be wrong

Ranked by consequence:

1. **`act`'s effective classpath** — unprovable from source by construction. Correctly recorded as unproven.
2. **The 21 Grade B sites I confirmed by receiver name rather than by tracing the bean** — a Spring `@Primary` bean or a subclass overriding a throwing method would defeat the whole grade. I did not exhaustively prove no such override exists; I grepped for one and found none.
3. **`market`'s referral payout path** (`ExchangeOrderService` :468-503) is flag-gated, and I read the dev value as false. A different profile flips it. It throws either way today.
4. **Whether `wallet` opens a port** — unresolved, and I decline to claim it in either direction.
5. **`exchange`'s `/monitor` handlers being verb-agnostic** — read from `@RequestMapping` without a method attribute. Correct as Spring semantics, but the effective route also depends on the module's boot state, which I did not verify.

---

## 8 · Coverage of this audit

870 non-test Java files is more than I read. Stating the edges, because a map implying completeness it does not have is worse than none.

**Read closely (whole file or the whole money region):**
`core:MemberWalletDao.java` · `core:MemberWalletService.java` · `core:WithdrawRecordService.java` (money methods) · `core:DualBookMoneyDoorInterceptor.java` · `wallet:FinanceConsumer.java` · `exchange-core:ExchangeOrderService.java` (all 9 mutator call sites) · `ucenter-api:PromotionController.java` (money region) · `usdt:WalletController.java` · `eth:WalletController.java` (money region) · `act/pom.xml` · all five gate scripts · the ADR · `vendor-compile.yml`.

**Sampled — specific lines verified, file not read end to end:**
The 8 trading-path sites at their named lines · the 3 cron spenders in `01_wallet_rpc` (schedule + send call) · `market:ExchangeTradeConsumer.java` (listeners + service calls) · `exchange:MonitorController.java` (mappings + Kafka sends) · `wallet:MemberConsumer.java`, `wallet:CoinConsumer.java` · `admin:CoinController.java` · both money-shaped test sources · compose service list.

**Enumerated only — counted and classified, not read:**
The remaining 21 Grade B call sites (confirmed receiver name, not traced through the bean) · the 13 wallet RPC controllers' full endpoint lists · `chat`, `cloud` and the job module beyond confirming no value surface · all 26 test sources (grepped, 2 read) · the 10 `@SpringBootApplication` and 6 `ApplicationConfig` inventories.

**Not examined:** the ~35 prebuilt jars, `.sql` files, front-end trees, and any resolved Maven classpath. **No compile or boot of the vendor tree was attempted.**

**Two subagent sweeps** produced the `00_framework` undoored-app and `01_wallet_rpc` inventories. I independently verified their load-bearing claims by direct read — the `act` pom versions, `usdt`'s missing amount check, the three cron schedules and send calls, `eth`'s caller-supplied sweep target, the `exchange`→`market` topic chain, and the `FinanceConsumer` ordering. Claims I did not personally re-read are marked "enumerated" above.

---

## 9 · What this map says should happen next

Not a work claim — the board owns sequencing. Ordered by what closes the most exposure per edit.

1. **Register a door on `exchange`, or require auth on `/monitor`.** The only finding here where the existing mechanism fits unchanged (§4.3).
2. **Extend the positive no-op assertion from 4 declarations to all 15.** Closes §6.2 with no allowlist, since it is a statement about declarations rather than a search for bad text — the same reasoning that justified check 2 originally.
3. **Assert the service stubs keep throwing.** Fifteen methods hold Grade B and nothing re-proves them.
4. **Put a control in front of `wallet:FinanceConsumer` :101 before that module ever gets a compose service** — §7.1 item 2, the one materially undocumented gap.
5. **Widen the compile probe past `core`**, still advisory. `exchange-core` would put the eight trading-path sites under the same continuously re-proved footing `core` now enjoys.
6. **Refresh the ADR's Grade table and the brief's figures** to 47/21 and 32 gates, so the next reader starts from the current tree.

Items 4 and 5 touch `vendor/**` money code and the wallet RPC security review remains owner-gated; nothing here should be read as agent-cleared work.
