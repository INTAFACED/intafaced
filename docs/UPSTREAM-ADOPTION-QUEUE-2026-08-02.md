# Adopt the whole app, keep one book — the work queue

**Type:** executable queue. **Status:** ready to assign. **No service, vendor or app source changed by this document.**
**Written against:** `main` @ `a43b469`, live fleet on this machine, 2026-08-02.
**Direction it implements — confirmed by the owner, settled:**

> _"Yes for the product. No for the book. Take their shell, their screens, their OTC
> and admin workflows, their business logic, and their wallet RPC as the starting
> point. Keep our ledger as the single place balances live, and have their money
> controllers call it through an adapter instead of writing `member_wallet`."_

This document does not evaluate that direction. It makes it executable.

---

## 0 · The reconciliation, in one line

**Adopt the whole app. Keep one book.**

The balance-ownership ADR is `Status: Accepted` — Option B, `ledger.*` is the only book
([`docs/adr/2026-07-28-vendored-exchange-integration.md:3`](adr/2026-07-28-vendored-exchange-integration.md)). That is settled and this
queue does not reopen it. What the ADR forbids is a **second set of books**, not a
second **codebase**. A vendored controller that keeps its validation, its state
machine, its appeal flow and its screens, and calls `packages/ledger-client`
where it used to call `MemberWalletDao`, is not a second book. It is our book,
reached through their door.

So the queue has five buckets and one rule each:

| Bucket                | Rule                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| **1 · ADOPT AS-IS**   | It runs, it writes no balance. Stop rebuilding it.                    |
| **2 · ADOPT + ADAPT** | Keep the controller and its logic. Redirect the balance write.        |
| **3 · REWIRE**        | Keep the screen. Point it at `svc-edge`.                              |
| **4 · DELETE**        | Dead weight. Justified one by one.                                    |
| **5 · REPLACE**       | Ours substitutes for theirs, and the two **cannot run side by side**. |

Bucket 5 is narrow on purpose. "Delete" is for things nobody wants; **"replace" is
for things that would still work if we ran them, and that is exactly the danger** —
two implementations of one truth, both live, silently disagreeing. §7 names all
four members and shows there is no fifth.

### 0.1 The corrected controller split

The estimate in circulation is _"roughly 75 of 96 controllers adopted as-is, ~21
adapted, one subsystem replaced."_ **Counted properly, three of those four numbers
are wrong**, and the arithmetic is worth showing because the denominator is the
part people keep getting wrong.

```
find vendor/upstream-exchange -name '*Controller.java'          → 108
  01_wallet_rpc                                            →  14   (13 per-chain WalletController + RpcController)
  00_framework                                             →  94
```

**`01_wallet_rpc` has 14 controllers, not 13.** The audit said "12 per-chain
`WalletController` + `RpcController`". There are **thirteen** chains on disk — `act`,
`bch`, `bitcoin`, `bsv`, `btm`, `ect`, `eos`, `erc-eusdt`, `erc-token`, `eth`, `ltc`,
`usdt`, `xmr` — plus `rpc-common/RpcController`. Every downstream count that
subtracted 13 is off by one.

Of the 94 in `00_framework`, the money set is
`grep -rl "MemberWalletService\|MemberTransactionService\|MemberWalletDao\|MemberTransaction " --include='*Controller.java'`
→ **exactly 25 files**, listed in full in §4.

| Bucket                                         |   Count | Correction                                           |
| ---------------------------------------------- | ------: | ---------------------------------------------------- |
| **1 · ADOPT AS-IS** (`00_framework`)           |  **68** | estimate said 75 — **7 too high**                    |
| **2 · ADOPT + ADAPT** (money controllers)      |  **25** | estimate said ~21 — **4 too low**                    |
| **`01_wallet_rpc`** — adopt, review first (§8) |  **14** | not in the estimate at all                           |
| **4 · DELETE** (`wallet/…/TestController`)     |   **1** | —                                                    |
| **Total**                                      | **108** | estimate's denominator of 96 matches nothing on disk |

**Where 96 came from and why it is not a real number.** It is 108 − 12, i.e.
subtracting the per-chain wallet controllers but not `RpcController` and not
`wallet/TestController`. With wallet RPC now explicitly in scope the honest
denominator is **108**; if you want a framework-only figure it is **94**. 96 is
neither.

**The two corrections that change decisions, not just arithmetic:**

- **68, not 75.** Seven fewer controllers are free. The gap is mostly `admin`'s
  money set — twelve of its 57 controllers write balances, and an estimate that
  puts them in "as-is" would have someone start the admin console expecting a
  read-only surface and find a fiat approval path.
- **25, not ~21.** Four more controllers need an adapter. And the number that
  actually governs the schedule is smaller and sharper: **of the 25, only 11 map
  onto recipes that already exist.** Eight need a new recipe written first (a
  Denon carve-out), three route elsewhere, three are near-fits. §4.2 has the
  breakdown. "~21 adapted" reads as one uniform pile of work; it is three piles
  with a dependency between them.

**"One subsystem replaced" is the fourth number, and it is the one that is too
low in the way that matters.** There are **four**, and two of them are hard
preconditions of bucket 2 rather than follow-ups. See §7.

---

## 1 · Six things changed under this plan while it was being written

Read this section before anything else. The brief that commissioned this
document, and the audit it rests on ([`docs/VENDORED-OVERLAP-AUDIT.md`](VENDORED-OVERLAP-AUDIT.md), probed 2026-07-30),
are both partly overtaken by code that has since landed.

> **The sixth is in §8 and it is the one to read first if you read only one.**
> Six of the fourteen `01_wallet_rpc` modules never load the auth interceptor —
> `rpc-common` is not on their classpath, so the `rpc.auth-token` line in their
> config is read by nothing and they start without it. Three of the six expose an
> **unauthenticated endpoint that generates a private key**. A document we are
> relying on records this perimeter as "real and enforced". It is enforced on
> eight modules.

### 1.1 The Java money doors are already shut. All of them.

The audit's headline finding was that `MemberWalletDao` "still declares, live"
the four balance mutators. **It does not, as of #234 and #289.** Every one is now
a no-op:

```java
// vendor/upstream-exchange/00_framework/core/.../dao/MemberWalletDao.java:26-27
@Query(value = "UPDATE member_wallet SET id = id WHERE 1 = 0", nativeQuery = true)
int increaseBalance(@Param("walletId") long walletId, @Param("amount") BigDecimal amount);
```

Same shape at `:33` (`decreaseBalance`), `:39` (`freezeBalance`), `:45`
(`thawBalance`), `:53` (`decreaseFrozen`), and eight more mutating queries
through `:173`.

And the HTTP layer is shut too. `DualBookMoneyDoorInterceptor.java` refuses **50
URI fragments** with `410 Gone`, registered on all four money-facing
`ApplicationConfig`s. Verified:

```
✓ dual-book-door-scan clean — interceptor + registration on admin, ucenter-api, otc-api, exchange-api
✓ vendor-java-money-scan clean — 882 Java file(s), 8 live-write pattern(s)
```

**What this means for bucket 2.** The work is not "find the balance writes and
redirect them" — that job was done. The work is **"open each door back up, one at
a time, behind an adapter that posts to our ledger, and delete its fragment from
`BLOCKED_URI_FRAGMENTS` in the same PR."** The interceptor list _is_ the bucket-2
backlog, and it is already written down. That is a much smaller job than the
brief assumed, and it has a built-in definition of done: a controller is adopted
when its fragment leaves that list and a ledger post replaces the no-op.

### 1.2 `custody-scan` is not the gate anyone thinks it is — and the Java gate that does exist is not in `pnpm verify`

The audit's F1 said `custody-scan` "walks `['.ts','.tsx']` only" and is therefore
"blind to the module that holds its own balance". Half right, and the other half
is worse.

`custody-scan` walks `.ts`/`.tsx` **inside four named services only** —
`['svc-chain','svc-dex','svc-indexer','svc-protocol']`
(`tooling/ci/custody-scan.mjs:31`). It is not a "no module holds its own balance"
gate at all. It is a **Protocol-Plane-does-not-import-ledger-writes** gate (§16.10).
Its own output says so: `✓ custody-scan clean — 97 files across 3 Protocol Plane service(s)`.
It has never read Java, and it has never read the other twelve TypeScript services either.
**Extending it to Java would be extending the wrong gate.**

The gate that _does_ read Java is `tooling/ci/vendor-java-money-scan.mjs` — 882
files, 8 live-write patterns, added with #289. That is the right one.

**The real hole, and it is a live one:**

```
"verify": "pnpm scan:agent-autoload && pnpm tracker:check && pnpm format:check
           && turbo run build typecheck test && pnpm scan:workspace
           && node tooling/ci/dod-gate.mjs"
```

— `package.json:34`. **`pnpm verify` runs none of the six scans.** Not
`scan:custody`, not `scan:vendor-java-money`, not `scan:vendor-shell`, not
`scan:dual-book-door`, not `scan:dual-book-door-paths`, not `scan:brand`. They run
only in `.github/workflows/ci.yml:38-48`. So every agent who reports "verify
green" has proved nothing about dual-book or custody, and the doctrine gate fires
for the first time after the push we were told to avoid making.

> **Action (tooling/CI — Denon):** add the five doctrine scans to `verify`. One
> line. It is the cheapest item in this entire document and it is the one that
> makes every other item enforceable locally.

**What no scan can prove, and what bucket 2 must therefore prove by test:** the
scans prove nothing writes `member_wallet`. They cannot prove an adapter posts to
our ledger _correctly_ — that the freeze became an `escrowLock`, that the release
became an `escrowRelease` with the right fee, that the reversal path exists.
Every bucket-2 PR needs a failure test alongside the happy path. That is the
enforcement gap to name, and it is a test-discipline gap, not a scanner gap.

### 1.3 PR #412 is open, not merged. The shell is still not deployable on `main`.

`gh pr list` → `412 feat(vendor): make the vendored trading shell deployable — OPEN`.
`grep -rn "8090\|shell-web\|Web_Front" --include="*.yml" .` over the repo returns
**nothing**. The audit's F7 still stands in full: the shell is hand-started,
bind-mounted, in no compose file.

Bucket 3 is blocked on #412 landing. **Merge #412 first.** It is the only thing
standing between "the direction" and "a thing you can open in a browser".

### 1.4 The Java stack is more down than the brief says

Live, this machine, right now:

| Container                                   | State            | Consequence                             |
| ------------------------------------------- | ---------------- | --------------------------------------- |
| `intafaced-cx-cloud`                        | Up 2 days        | Eureka only — 0 controllers             |
| `intafaced-cx-exchange`                     | Up 2 days        | matching module — **1** controller      |
| `intafaced-cx-market`                       | **Exited (1)**   | Mongo `OP_QUERY` — see §2.1             |
| `intafaced-cx-ucenter`                      | **Exited (1)**   | Redis AUTH — see §2.2                   |
| `intafaced-cx-otc`                          | **Exited (255)** | hand-started, not in compose — see §2.3 |
| `intafaced-cx-exchange-api`                 | **Exited (255)** | hand-started, not in compose — see §2.3 |
| `intafaced-shell-web`                       | **Exited (255)** | hand-started, not in compose — #412     |
| `admin`, `chat`, `wallet`, `job-module-job` | never started    | not in compose at all                   |

**1 of 94 controllers is reachable today** — `exchange/MonitorController`. Not 4
modules as the audit found on 30 July; two of those four have since died.

### 1.5 The mobile apps and the trading robot are empty. There is nothing to read.

The audit listed `02_App_Android`, `03_APP_IOS` and `06_ExchangeRobot` as
unexamined, and asked "who reads the mobile apps, and when?". `git ls-files`
answers it: **two files each — a `.keep` and a `README.md`.** They were stripped
at vendoring. Owner question #4 from the audit (`§7.4`) is closed by fact. Nobody
needs to read them; there is nothing there.

---

## 2 · FIX FIRST — these are blocking, not untidy

**The Java stack cannot be evaluated at all until it runs, and it is down for
three separate reasons.** That sentence is the whole justification for this
section's position in the document. Every adoption judgement below — is this
controller really read-only, does this screen really need rewiring, does the
admin console really work — rests on evidence we cannot gather from a stack where
**1 of 108 controllers answers a request**.

These are not housekeeping items to fit in around the real work. Until they land,
every bucket below and the wallet-RPC review in §8 are reasoning from
source-reading alone, and §10 says exactly where that reasoning stops being safe.

Three blockers plus a fourth nobody has named, exact remediation. All four are
**tooling/CI lane — Denon**. None of them touches money code.

### 2.1 `market` — MongoDB removed the wire protocol Spring Boot 1.5 speaks

**Verified cause**, from `docker logs intafaced-cx-market`:

```
Caused by: com.mongodb.MongoQueryException: Query failed with error code 352 and error
message 'Unsupported OP_QUERY command: find. The client driver may require an upgrade.
For more details see https://dochub.mongodb.org/core/legacy-opcode-removal'
on server cx-mongo:27017
    at com.mongodb.DBCursor.initializeCursor(DBCursor.java:870)
    at org.springframework.data.mongodb.core.MongoTemplate.executeFindMultiInternal(MongoTemplate.java:1967)
```

**The brief's diagnosis is wrong and it matters.** There is no `mongo:4.4` pin
anywhere in the repo — `grep -rn "mongo:4"` returns nothing.
`vendor/upstream-exchange-compose.yml:85` pins **`mongo:6`**, and
`docker exec intafaced-cx-mongo mongosh --eval "db.version()"` returns
**`6.0.28`**. Compose and container agree. Nothing needs recreating.

The actual cause is a version skew that no `--force-recreate` fixes: Spring Boot
`1.5.9.RELEASE` (`00_framework/pom.xml:32`) brings Spring Data MongoDB 1.x, whose
`MongoTemplate` uses the legacy `com.mongodb.DBCursor` API. That API emits
`OP_QUERY`, which **MongoDB 5.1 removed**. The driver version
(`mongodb-driver.version = 3.12.14`, `pom.xml:46`) is not the problem — the
legacy template path is, and bumping the driver alone will not move it.

**Remediation — do the cheap one now, file the correct one:**

```yaml
# vendor/upstream-exchange-compose.yml — cx-mongo
- image: mongo:6
+ # 4.4 is the last server that speaks OP_QUERY, which Spring Data MongoDB 1.x
+ # (Boot 1.5.9) emits via the legacy DBCursor API. Not a preference — 5.1
+ # removed the opcode. Correct fix is Boot/Spring-Data upgrade; that is a project.
+ image: mongo:4.4
```

**And the trap that comes with it, which is easy to miss and costs a day.** The
healthcheck on the same service is:

```yaml
test: ['CMD', 'mongosh', '--quiet', '--eval', 'db.adminCommand("ping")']
```

**`mongosh` does not exist before MongoDB 5.** On a 4.4 image that healthcheck can
never pass, so the container sits `unhealthy` forever and `cx-market` — which
has `depends_on: cx-mongo: {condition: service_healthy}` — never starts, behind
a database that is perfectly fine. It must become `mongo` in the same edit:

```yaml
- test: ['CMD', 'mongosh', '--quiet', '--eval', 'db.adminCommand("ping")']
+ test: ['CMD', 'mongo',   '--quiet', '--eval', 'db.adminCommand("ping")']
```

then, because a 6.0 data directory will not mount on 4.4:

```bash
docker compose -f vendor/upstream-exchange-compose.yml rm -sf cx-mongo
docker volume rm vendor_cx-mongo          # 0 rows of value — see §3.3 of the audit
docker compose -f vendor/upstream-exchange-compose.yml up -d cx-mongo cx-market
```

Losing that volume costs nothing: every table behind it is empty.
**Size: S.** Note `docs/DIRECTION-2026-07-31.md` §6 already calls
`feat/spine-market-seeder` **RESUME, priority** for exactly this.

**Do not** "fix" it by downgrading to the README's MongoDB 3.6 — EOL 2021, and the
compose header at line 34-45 explains at length why that door is closed.

> **Collision notice.** As this was written, an uncommitted edit in the **main
> checkout** is making exactly this change — `mongo:4.4` plus the `mongosh` → `mongo`
> healthcheck. Independent arrival at the same fix, and the healthcheck catch is
> theirs. **Whoever lands it: that draft also drops the `127.0.0.1:` prefix from
> the published port, which silently reverts #409** (`fix(vendor): bind the vendored
datastores to loopback, not every interface`). Keep the binding.

### 2.2 `ucenter` — the client sends a Redis password the server has never been configured to want

**Verified cause**, from `docker logs intafaced-cx-ucenter`:

```
Caused by: redis.clients.jedis.exceptions.JedisDataException:
ERR AUTH <password> called without any password configured for the default user.
Are you sure your configuration is correct?
    at redis.clients.jedis.BinaryJedis.auth(BinaryJedis.java:2139)
    ... RedisHttpSessionConfiguration$EnableRedisKeyspaceNotificationsInitializer
```

It fails at context refresh, so the process exits — this is not a degraded
service, it is a service that cannot boot.

**Both halves verified:**

- Seven `application.properties` set `spring.redis.password=${COINEX_REDIS_PASSWORD}` —
  `admin:32`, `job-module-job:75`, `chat:29`, `exchange-api:24`, `market:91`,
  `otc-api:41`, `ucenter-api:40`.
- `vendor/upstream-exchange-compose.yml:97-99` declares `cx-redis` with **no
  `command:`**, so no `--requirepass`. `docker exec intafaced-cx-redis redis-cli
CONFIG GET requirepass` returns **empty**.

**Remediation — set the password, do not delete it.** The tempting fix is to
comment out the seven property lines. Do not: that leaves an unauthenticated
Redis holding every user session, and `docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md`
already rates this perimeter P1–P4.

```yaml
# vendor/upstream-exchange-compose.yml — cx-redis
  cx-redis:
    image: redis:7-alpine
+   command: ['redis-server', '--requirepass', '${COINEX_REDIS_PASSWORD:-cx_dev_only}']
    ...
    healthcheck:
-     test: ['CMD', 'redis-cli', 'ping']
+     test: ['CMD', 'redis-cli', '-a', '${COINEX_REDIS_PASSWORD:-cx_dev_only}', 'ping']
```

and every Java service gains:

```yaml
environment:
  COINEX_REDIS_PASSWORD: ${COINEX_REDIS_PASSWORD:-cx_dev_only}
```

The Java services currently have **no `environment:` block at all**, which is why
`${COINEX_REDIS_PASSWORD}` resolves to nothing coherent inside the container.
**Size: S.**

### 2.3 `otc-api` and `exchange-api` are not in the compose file, so they cannot be started

`vendor/upstream-exchange-compose.yml` defines exactly eight services: `cx-mysql`,
`cx-mongo`, `cx-redis`, `cx-kafka`, `cx-cloud`, `cx-exchange`,
`cx-market`, `cx-ucenter`.

**Absent:** `otc-api` (6006), `exchange-api` (6003), `admin`, `chat`,
`job-module-job`, `wallet`, and the Vue shell. The `intafaced-cx-otc` and
`intafaced-cx-exchange-api` containers on this machine were hand-started, are
`Exited (255)`, and `docker compose up` will not bring them back because compose
does not know they exist.

**Remediation** — add four service blocks mirroring `cx-ucenter`. Ports from
each module's `dev/application.properties` (`exchange-api:1` → `6003`,
`otc-api:1` → `6006`), context-paths `/exchange` and `/otc` (`:3` and `:2`):

```yaml
cx-exchange-api:
  image: eclipse-temurin:8-jre
  container_name: intafaced-cx-exchange-api
  working_dir: /app
  volumes: ['./upstream-exchange/00_framework:/app:ro']
  command: ['java', '-Xms256m', '-Xmx512m', '-jar', 'exchange-api/target/exchange-api.jar']
  environment: { COINEX_REDIS_PASSWORD: '${COINEX_REDIS_PASSWORD:-cx_dev_only}' }
  ports: ['127.0.0.1:${COINEX_EXCHANGE_API_PORT:-6003}:6003']
  depends_on:
    cx-market: { condition: service_started }
    cx-redis: { condition: service_healthy }

cx-otc:
  # …identical shape, otc-api/target/otc-api.jar, 6006
cx-admin:
  # …admin/target/admin-api.jar — see the caution below
cx-chat:
  # …chat/target/chat.jar — bucket 1, no money
```

**A caution that used to be a blocker and is now only a caution.** The audit's
§7.5 said "what I would _not_ do: start the vendored `admin` module" — because
twelve of its controllers wrote balances and `member_wallet` was pristine. **That
reasoning is retired by §1.1**: the DAO mutators are no-ops and all twelve admin
money paths are in `BLOCKED_URI_FRAGMENTS`. Starting `admin` now surfaces 45
read-only controllers with the 12 money doors returning 410. The remaining
caution is the perimeter, not the money: committed actuator basic-auth including
`heapdump` (A1.4, P1). Bind it to loopback like everything else in that file and
start it.

**Size: M** (four services, plus the perimeter check on `admin`).

### 2.4 The fourth blocker nobody has named: the jars are not in the repo, and nothing builds them

`find vendor/upstream-exchange/00_framework -name "*.jar" -path "*/target/*"` in this
worktree returns **nothing**. The same command against the main checkout returns
**13 jars**. `target/` is gitignored; the compose `command:` lines are
`java -jar …/target/….jar`.

So the vendored stack starts on exactly one machine, from build output that
exists only there, produced by a Maven run nobody has scripted. A fresh clone
cannot start any of it, and neither can CI. Every "the vendored app is robustly
built" claim currently rests on artefacts that are one `git clean -xdf` from
gone.

**Remediation:** a `maven:3.8-openjdk-8` build stage — either a builder service in
the compose file or a `pnpm vendor:build` script. The ADR already establishes the
container-build approach (§"No JDK or Maven on this machine"). **Size: M.**
This is the item that turns "it runs here" into "it runs".

---

## 3 · Bucket 1 — ADOPT AS-IS

**Placement rule:** it writes no balance, it needs no adapter, and the only thing
between us and it is §2. **68 of the 94 controllers.**

Counted, not asserted: `find vendor/upstream-exchange -name '*Controller.java'` → **108**.
Minus 13 in `01_wallet_rpc` (12 per-chain `WalletController` + `RpcController`)
→ **95**. Minus `wallet/…/TestController.java` → **94**. Of those, 25 touch
`MemberWalletService` / `MemberTransaction` (§4), leaving **68**.

### 3.1 The five with no tracker row — this is why they keep getting rebuilt

An agent cannot avoid duplicating work that is not on the board.
`tooling/tracker/features.mjs` has 130 rows; I extracted every id and checked.
**These five vendored capabilities have no row of any kind:**

| #   | Capability                             | Vendored implementation                                                                                                | Screens                       |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | **CMS** — announcements, help, notices | `admin/cms/{Advertise,Help}Controller`, `admin/system/AnnouncementController`, `ucenter/{Announcement,Aide}Controller` | 7 finished `pages/cms/*.vue`  |
| 2   | **Site content model / config**        | `admin/system/{DataDictionary,WebsiteInformation,AppRevision,MemberApplicationConfig}Controller`                       | —                             |
| 3   | **Red envelope**                       | `ucenter/RedEnvelopeController`, `admin/redenvelope/RedEnvelopeController`, `admin/job/CheckRedEnvelopeJob`            | `pages/envelope/Envelope.vue` |
| 4   | **Activity / sign-in / bonus**         | `admin/activity/{Activity,Sign}Controller`, `ucenter/{Activity,Bonus}Controller`                                       | 4 `pages/activity/*.vue`      |
| 5   | **CTC — fiat acceptor desk**           | `ucenter/CtcController`, `admin/ctc/{AdminCtcOrder,AdminCtcAcceptor}Controller`                                        | `pages/ctc/Ctc.vue`           |

**A sixth, and it is the worst one:** the vendored **Vue shell itself has no
tracker row**. `web.shell` (`features.mjs:329`) is `requires: ['apps/web']` —
`apps/web`, not the shell. The thing the owner has three times called "the app"
is not on the board at all, while the thing he did not ask for is `done`. That
single line is the mechanism by which the stated direction and the running system
drifted apart, and it is a one-line fix.

Three more that _do_ have rows but at 🟢 not-started, and are therefore also
being rebuilt from nothing while a finished version sits on disk:
`ops.support` (support chat), `ops.analytics` (statistics/finance reporting),
`ops.admin` (`ready`, and its own note says "apps/admin has ZERO test files and
makes no network call of any kind. Every kill-switch, freeze and reconcile is
React `useState` in the browser").

> **`apps/admin` is a console that appears to halt the ledger and does not.**
> The vendored admin console is 57 controllers plus 92 `.vue` files that
> genuinely talk to a backend. That comparison is the strongest single argument
> in the owner's favour anywhere in this document.

### 3.2 The 68, by group

**`admin` — 45 of 57 (the other 12 are bucket 2)**

| Group                     | Controllers                                                                                                                      | n   | Note                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------ |
| CMS                       | `cms/AdvertiseController`, `cms/HelpController`                                                                                  | 2   | site banners + help centre. No tracker row.      |
| Content / site config     | `system/{Announcement,DataDictionary,WebsiteInformation,AppRevision,MemberApplicationConfig,TransferAddress,GoogleVerification}` | 7   | No tracker row.                                  |
| **RBAC scaffolding**      | `system/{Role,Permission,Employee,Department,AccessLog}Controller`                                                               | 5   | a finished permission model. `ops.admin` 🟢      |
| Reporting — system        | `system/StatisticsController`                                                                                                    | 1   | member/delegation/order/dashboard/order-rate     |
| Reporting — finance       | `finance/{FinanceStatistics,ExchangeTransaction,MemberDepositRecord}Controller`                                                  | 3   | **reads only** — verified, no wallet writes      |
| Rewards read/config       | `system/{MemberBonus,RewardActivityRecord}Controller`, `promotion/{MemberPromotion,RewardPromotion,RewardRecord}Controller`      | 5   | config + read; the credit path is bucket 2       |
| Exchange config / read    | `exchange/{ExchangeCoin,ExchangeInitPlate,ExchangeOrder,ExchangeOrderDetail,ExchangeOrderMineDetail,HTLExchangeInitPlate}`       | 6   | listings + order **read**; the write is bucket 4 |
| OTC config / read         | `otc/{AdminOtcCoin,AdminAdvertise,AdminOrder}Controller`                                                                         | 3   | **fixes audit F4** — `otc_coin` empty is config  |
| Member non-money          | `member/{MemberApplication,MemberLevel,InviteManagement}Controller`                                                              | 3   | `identity.rank` ✅ overlaps `MemberLevel`        |
| Merchant KYB (apply side) | `businessAuth/BusinessAuthController`                                                                                            | 1   | the bond move is bucket 2                        |
| CTC acceptor config       | `ctc/AdminCtcAcceptorController`                                                                                                 | 1   | no tracker row                                   |
| Sign-in campaign config   | `activity/SignController`                                                                                                        | 1   | no tracker row                                   |
| Red envelope admin        | `redenvelope/RedEnvelopeController`                                                                                              | 1   | no tracker row                                   |
| SMS provider config       | `code/SmsProviderController`                                                                                                     | 1   | `ops.notifications` 🟢 — ours refuses honestly   |
| Console plumbing          | `common/{BaseAdmin,Global,Index,Upload}Controller`, `index/IndexController`                                                      | 5   | login, nav, file upload                          |

**`ucenter-api` — 13 of 23**

`AideController`, `AnnouncementController`, `BonusController`, `CoinController`,
`FeedbackController`, `GeetestController`, `GoogleAuthenticationController`,
`LegalWalletRechargeController`, `LoginController`, `MiningOrderController`,
`RegisterController`, `SmsController`, `UploadController`.

`LegalWalletRechargeController` earns its place here on evidence: it writes a
request row at `state = APPLYING` and moves no value — the money is in the
_admin_ counterpart (bucket 2). The audit found this and it is still true.

**`chat` — 2 of 2.** `HistoryMessageController`, `WebSocketController`. The whole
module, jar already built, zero money. `ops.support` is 🟢 not started. This is
the cleanest adopt in the document — one compose block against a service we have
not begun.

**`market` — 2 of 2.** `MarketController` (13 routes), `ExchangeRateController`.
Adopt with a hard caveat: the data is **seeded and synthetic**
(`vendor/upstream-exchange/seed-market-data.mjs` header says so; `volume: 0.0000`).
Audit F5 stands. Adopting the module is fine; **presenting its candles as market
truth is not**, and that is the honesty line `docs/STREAM-A-PHASE1-PLAN.md`
already draws.

**`exchange-api` — 2 of 3.** `ExchangeCoinController` (listings),
`FavorController` (watchlist). `OrderController` is bucket 4.

**`otc-api` — 1 of 3.** `OtcCoinController`. `Advertise` and `Order` are bucket 2.

**`core` — 2 of 2.** `BaseController`, `CaptchaController`.

**`exchange` — 1 of 1.** `MonitorController` — the only controller reachable today.

### 3.3 What bucket 1 costs and what it saves

Cost: §2's compose work, plus one perimeter pass on `admin`'s actuator. **Size: M
for the whole bucket**, because §2 is shared across all of it and each additional
module after the first is a copy-pasted compose block.

Saves: 68 finished controllers and roughly 20 finished screens across CMS,
support chat, statistics, RBAC and site config — five of which are not on the
board and so are being rebuilt by accident, and three of which are on the board
at not-started.

---

## 4 · Bucket 2 — ADOPT + ADAPT · **the recipe map**

**Placement rule:** it moves value. Keep the controller, its validation, its
state machine, its screens. Replace the balance write with a `ledger.post()`.

**25 controllers**, verified by
`grep -rl "MemberWalletService\|MemberTransactionService\|MemberWalletDao\|MemberTransaction " --include='*Controller.java'`
→ exactly 25 files. Of those, **7 call the four DAO mutators directly** (per
`node tooling/scripts/vendor-money-inventory.mjs`, 14 call-site lines); the other
18 mutate through `setBalance` / `setFrozenBalance` + `save`, or delegate to a
service that does.

### 4.1 The map

Recipes are from `packages/ledger-client/src/recipes/` — `index.ts` (31 recipes),
`bank.ts` (5), `loans.ts` (7). **`recipes` is the only export surface**;
`ledger.post(recipes.x({…}))` is the whole calling convention, and an inline
entry list is a review rejection (`recipes/index.ts:24-34`).

Legend: **✅ exact** — the recipe already expresses this movement.
**◑ near** — the shape fits, the metadata does not. **✖ gap** — no recipe exists.

---

#### ✅ EXACT — 11 controllers, no new recipe needed

**1 · `otc-api/…/OrderController`** — the OTC trade lifecycle. The single
cleanest mapping in the tree.

| What it does             | Vendored call                                           | Recipe                                                      |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------- |
| buyer takes an advert    | `freezeBalance(wallet, amount)` — `:367`                | `escrowLock({tradeId, sellerId, buyerId, assetId, amount})` |
| buyer cancels            | `thawBalance(memberWallet, order.getNumber())` — `:532` | `escrowRefund({resolution:'cancelled'})`                    |
| system expires the order | `thawBalance(…, number + commission)` — `:544`          | `escrowRefund({resolution:'expired'})`                      |
| seller confirms fiat     | `memberWalletService.transfer(order, ret)` — `:643`     | `escrowRelease({feeBps})`                                   |

Our `svc-p2p` already does exactly this — `p2p-service.ts:592` posts
`recipes.escrowLock`, and `p2p.escrow` is `done`. The adapter is thin because
both sides already agree on the concept. Door fragments to lift:
`/order/buy`, `/order/sell`, `/order/cancel`, `/order/pay`, `/order/release`.

**2 · `admin/…/otc/AdminAppealController`** — dispute resolution.
`thawBalance(memberWallet, amount)` at `:231` → `escrowRefund({resolution:'appeal-seller'})`;
`memberWalletService.transferAdmin(order, ret)` at `:300` → `escrowRelease`.
`p2p.disputes` is `done`. Fragments: `/otc/appeal/release-coin`, `/otc/appeal/cancel-order`.

**3 · `ucenter-api/…/WithdrawController`** — crypto withdrawal request.
`freezeBalance(memberWallet, amount)` at `:257` → **`withdrawHold({userId, assetId, amount, rail, withdrawalId})`**.
Fragment: `/withdraw/apply`.

**4 · `admin/…/finance/WithdrawRecordController`** — the approval half of the same
flow, and it is where the money actually leaves.
`setFrozenBalance(getFrozenBalance().subtract(totalAmount))` + `save` at
`:226-227` (audit-pass) and `:272-273` (remittance)
→ **`withdrawSettle`**; audit-no-pass → **`withdrawReverse`**.
Fragments: `/finance/withdraw-record/{audit-pass,audit-no-pass,remittance,add-transaction-number}`.

> `withdrawHold` → `withdrawSettle` / `withdrawReverse` is a purpose-keyed
> three-step that already exists precisely because a rail can refuse
> (`recipes/index.ts:104-149`). The vendored flow is the same three steps split
> across two modules. Adopt both together or neither — half of it strands value
> in a hold with no settle path.

**5 · `ucenter-api/…/LegalWalletWithdrawController`** and
**6 · `admin/…/member/LegalWalletWithdrawController`** — fiat withdrawal.
`legalWalletWithdrawService.withdraw(wallet, …)` (`ucenter:82`) → `withdrawHold({rail:'fiat-<method>'})`;
`pass`/`remit` (`admin:58`,`:90`) → `withdrawSettle`; `noPass` (`admin:73`) → `withdrawReverse`.
Fragment: `/legal-wallet-withdraw`.

**7 · `admin/…/member/LegalWalletRechargeController`** — fiat deposit approval.
`legalWalletRechargeService.pass(wallet, legalWalletRecharge)` at `:63`
→ **`deposit({rail:'fiat-<method>', railRef:<recharge id>})`**. `noPass` at `:73`
posts nothing — no value moved. Fragment: `/legal-wallet-recharge`.

**8 · `admin/…/member/MemberWalletController`** — operator manual credit.
`setBalance(getBalance().add(amount))` + `memberTransactionService.save` at
`:146-159` → **`deposit({rail:'admin-manual', railRef:<ticket id>})`**.

> Exact, and **the most dangerous door in the tree** — an unbounded operator mint
> reachable over HTTP. Adopt behind a scope + dual-control + a mandatory
> `railRef` that names a real ticket, or leave the fragment in place. Also at
> `:224`/`:235`: `lockWallet` / `unlockWallet`. Those are a per-user posting
> freeze, and our equivalent is the ledger freeze / kill-switch — **a Denon §3
> carve-out** ("anything that touches a posture gate, kill-switch, or custody
> scan"). Do not build a second freeze.

**9 · `ucenter-api/…/TransferController`** — internal transfer between members.
`deductBalance(memberWallet, add(amount, fee))` at `:127`
→ **`bankTransfer({from, to, amount, kind:'manual', occurrence:0})`**

- **`feeCharge({mode:'asset'})`** as a separate post.
  `bankTransfer` takes `AccountRef`s and refuses cross-asset and non-`available`
  kinds (`bank.ts:76-88`), which is exactly the guard this controller lacks.

**10 · `ucenter-api/…/AssetController`** — READ ONLY (`/asset/wallet`,
`/asset/transaction`, `/asset/wallet/{symbol}`). No mutation in the controller.
Re-point to `ledger.accounts` / `ledger_entries` via the edge.

> **Do this one first.** It is what the shell shows a user as "my balance". Until
> it reads our ledger, every screen in bucket 3 is displaying an empty
> `member_wallet` while the user's real value sits in `ledger.accounts` — which
> is the "two balance systems in one page" the audit named in §3.5. **Size: S.
> Highest value-per-hour in this document.**

**11 · `admin/…/finance/MemberTransactionController`** — READ ONLY (`/all`,
`/detail`, export). Re-point to `ledger.ledger_tx` + `ledger_entries`. **Size: S.**

---

#### ◑ NEAR — 3 controllers, shape fits, journal metadata will read oddly

**12 · `ucenter-api/…/CtcController`** and
**13 · `admin/…/ctc/AdminCtcOrderController`** — the CTC fiat acceptor desk.

| What it does          | Vendored call                                         | Recipe                               |
| --------------------- | ----------------------------------------------------- | ------------------------------------ |
| user places CTC order | `freezeBalance(memberWallet, amount)` — `ucenter:267` | `escrowLock`                         |
| user cancels          | `thawBalance(…, order.getAmount())` — `ucenter:396`   | `escrowRefund`                       |
| admin completes       | `increaseBalance(mw.getId(), amount)` — `admin:182`   | `escrowRelease`                      |
| admin marks paid      | `decreaseFrozen(mw.getId(), amount)` — `admin:222`    | (leg of `escrowRelease`)             |
| admin cancels         | `thawBalance(memberWallet, amount)` — `admin:327`     | `escrowRefund({resolution:'admin'})` |

CTC is P2P with a designated acceptor, so the p2p escrow recipes fit the movement
exactly. What does not fit is the journal: every entry will read `module: 'p2p'`,
`reason: 'p2p.escrow.*'`. That is acceptable and should be recorded rather than
papered over — CTC has no tracker row and no TypeScript analogue, so `p2p` is the
honest home for it. Fragments: `/ctc/{new,cancel,pay}-ctc-order`,
`/ctc/order/{complete,pay,cancel,confirm}-order`.

**14 · `admin/…/system/CoinController`** — mostly listing config (bucket 1), but
`:387` writes a hot-wallet transfer record and `:475` touches a wallet.
The on-chain half belongs to `svc-protocol` / `svc-pay`, and `01_wallet_rpc` is
deliberately shut (`c221cc8`). **Split it:** adopt the coin CRUD as-is, leave the
hot-transfer path in bucket 4.

---

#### ✖ GAP — 8 controllers where no recipe exists

Each of these needs a **new recipe**, and adding a recipe is explicitly
**Denon's carve-out** (`docs/DIRECTION-2026-07-31.md` §3: _"anything that adds or
changes a ledger recipe"_). Agents may not invent them. The right move is one
recipes PR that adds all of them, reviewed once, ahead of the adapters — §15.2's
normal ordering.

**15 · `otc-api/…/AdvertiseController`** — advert-level inventory reservation.
`freezeBalance(memberWallet, advertise.getNumber())` at `:225` on publish;
`thawBalance(memberWallet, advertise.getRemainAmount())` at `:252` on
delist/delete.

**This is a genuine capability gap, not a naming one.** `svc-p2p` locks at _take_
time (`p2p-service.ts:434` — "Taking an offer → escrowLock"); the vendored desk
locks at _publish_ time, so a seller cannot advertise inventory they have already
committed elsewhere. Ours can, and it is the better product that the vendored app
has. `orderHold` / `orderHoldRelease` is the correct _shape_ — purpose-keyed by
an id, released on cancel, `orderHoldAccount` — but its `module: 'trade'` /
`reason: 'order.hold'` are wrong for a P2P advert.
**Proposed: `p2pOfferHold` / `p2pOfferRelease`, modelled line-for-line on
`orderHold` / `orderHoldRelease` with `module: 'p2p'`.**
Fragments: `/advertise/{create,update,on/shelves,off/shelves,delete}`.

**16 · `ucenter-api/…/ApproveController`**, **17 · `admin/…/member/MemberController`**,
**18 · `admin/…/businessAuth/BusinessCancelApplyController`** — the merchant KYB bond.
`ApproveController:607-608` moves `balance → frozenBalance` (posting the bond);
`MemberController:148-171` releases or forfeits it on approve/reject;
`BusinessCancelApplyController:161-164` returns it on cancellation.

Structurally identical to `loanCollateralLock` / `loanCollateralRelease` —
purpose-keyed, user-owned, `assertPairedLocks`-provable — but calling a merchant
bond a loan collateral would put `reason: 'loan.collateral.locked'` in the journal
for something that is not a loan.
**Proposed: `merchantBondLock` / `merchantBondRelease` / `merchantBondForfeit`,
`module: 'p2p'`** (`p2p.merchants` is the tracker row that exists and is not
started). The forfeit leg has no analogue at all — it moves a user's own locked
value to `houseFees`, which nothing currently does.
Fragments: `/approve/certified/business/apply`, `/approve/cancel/business`,
`/audit-business`, `/cancel-business`, `/business/cancel-apply/check`.

**19 · `ucenter-api/…/PromotionController`** — promotion-card order.
`increaseFrozen(memberWallet.getId(), newOrder.getAmount())` at `:480`.
The payout side maps to `rewardPay` (out of `rewardsEngine`, funded by
`sweepFeesToRewards`) — but the _lock_ side has nothing. `ops.affiliates` is 🟢.
**Owner decision required before building a recipe for a product nobody has asked
for.**

**20 · `ucenter-api/…/RedEnvelopeController`** — `setBalance(add(redAmount))` at
`:373` and `:562` credits a receiver. Payout maps to `rewardPay`; the sender-side
lock (and `admin/job/CheckRedEnvelopeJob`'s expiry thaw, 2 hits) has no recipe.
**See bucket 4 — this is a delete candidate, not a build candidate.**

**21 · `admin/…/activity/ActivityController`** — IEO / activity distribution.
`thawBalance` `:336`, `increaseBalance` `:347`/`:401`, `decreaseFrozen`
`:382`/`:435`, plus five `memberTransactionService.save` calls. A token-sale
settlement — closest existing shape is `tradeFill`, which does not fit a
one-sided distribution. **See bucket 4.**

**22 · `ucenter-api/…/ActivityController`** — `attend`, delegating to
`ActivityOrderService.freezeBalance`. Same gap, user side. **See bucket 4.**

---

#### Not adapted — 3 of the 25 route elsewhere

**23 · `exchange-api/…/OrderController`** — spot order add/cancel
(`/order/add:74`, `/order/cancel/{orderId}:415`), delegating to
`ExchangeOrderService` (8 mutator hits). This maps perfectly to `orderHold` /
`orderHoldRelease` / `tradeFill` — **and that is exactly why it should not be
adapted.** `matching.engine` ✅ and `trade.spot` ✅ already do it, tested, against
our book. Adopting a second matching engine is the one place where "adopt the
whole app" would cost us something we already have and is better.
**→ bucket 5 · REPLACE (§7.2)** — not bucket 4, because the vendored engine
container is running right now and the two must never be live together.
Keep the _screen_ (`pages/exchange/Exchange.vue`); replace the _engine_.

**24 · `ucenter-api/…/MemberController`** — `signInIncident(member, memberWallet, sign)`
at `:66`, a daily sign-in bonus credit → `rewardPay`. **→ bucket 4** pending the
owner's answer on whether sign-in bonuses are a product.

**25 · `admin/…/system/DividendController`** — `setBalance(add(x.getBalance(), va))`

- `save` in a loop over `findAllByCoin` at `:148-170`. A mass credit to every
  holder of a coin — structurally the shape `vendor-shell-scan` was written to ban.
  `token.yield` is ✅ and `rewardPay` + `sweepFeesToRewards` already express real-yield
  distribution from a funded pot. **→ bucket 4.** Fragment `/system/dividend` stays.

### 4.2 Bucket 2 summary

| Outcome                         | Controllers | Recipe work                       |
| ------------------------------- | ----------: | --------------------------------- |
| ✅ exact — adapter only         |          11 | none                              |
| ◑ near — adapter + journal note |           3 | none                              |
| ✖ gap — needs a recipe first    |           8 | ~6 new recipes, one PR, **Denon** |
| → bucket 4 (2) / bucket 5 (1)   |           3 | none                              |
| **Total**                       |      **25** |                                   |

**This is the table that corrects "~21 adapted".** The count is 25, and it is not
one pile: 11 can start as soon as §7.3 lands, 3 more need a journal-metadata
decision recorded, and **8 cannot start at all until a recipes PR lands in
Denon's carve-out**. Scheduling 25 as a single lane would stall two thirds of the
way through waiting on a PR nobody had been asked to write.

**Three constraints that are not negotiable:**

0. **The identity id must resolve first (§7.3).** An adapter cannot post to
   `userAvailable(userId, …)` without knowing which `userId` a vendored
   `member.id` is. `ledger.accounts.owner_id` is `text` and will silently accept
   the wrong one. **No adapter before this.**

1. **`decimal(18,8)` vs `numeric(38,18)`.** Every amount crossing the adapter
   truncates at the 8th decimal. The ADR flagged it on 28 July and it is still
   true (`adr/…-integration.md:82-89`); the ledger's own conformance suite
   round-trips `0.000000000000000001`. Widen `member_wallet.balance` and
   `frozen_balance` to `decimal(38,18)` **before the first adapter ships**, not
   after. It is arithmetic, not preference.
2. **Money never becomes a `number` on the adapter path.** Decimal strings on the
   wire, scaled `bigint` in memory. The vendored side is `BigDecimal` throughout,
   so this is a serialisation discipline, not a rewrite.

### 4.3 Ownership — and this one is a hard stop

**Bucket 2 is `M7` and `M7` belongs to `shehzad002`.**
`docs/SHEHZAD-HARD-OWNERSHIP-2026-08-01.md:39` — _"M7 Custody residual · Vendor
Java money doors — only after #289 agent merge"_ — and `:190-195` — _"Own after
#289 merged/absorbed: remaining entity/Spring live balance doors, scans,
Denon-visible self-audit."_ #289 is merged (`e29748f`).

`AGENTS.md:13`: **"Agents must not implement on HUMAN-CLAIMED M1–M7 / H-\* lanes
(babysit only)."** Nitro agents may write the adapter _specs_, the recipe
_proposals_, and the test _plans_. They may not open the doors.

The recipe additions in §4.1's ✖ group are **Denon's** (§3 carve-out), and they
must land **before** the adapters, per §15.2.

---

## 5 · Bucket 3 — REWIRE · the 74 screens

**Verified count**: `find vendor/upstream-exchange/05_Web_Front/src -name '*.vue'` →
**74** (43 under `pages/`, 30 under `components/`, plus `App.vue`).

I classified all 74 by what they actually call — `/api/*` is `svc-edge`
(`config/intafaced.js:28`: _"Everything our own services expose reaches the
browser through ONE door"_); `/uc`, `/market`, `/exchange`, `/otc`, `/chat` are
the Java services (`config/index.js:24-31`).

| Class                                |   n | Meaning                                           |
| ------------------------------------ | --: | ------------------------------------------------- |
| **EDGE** — calls only `/api/*`       |  12 | already ours                                      |
| **MIXED** — calls both               |   1 | `pages/intafaced/Dex.vue`                         |
| **JAVA** — calls a dead Java service |  45 | 38 with literal paths, 7 via the `this.api.*` map |
| **STATIC** — no backend call at all  |  16 | presentational; nothing to rewire                 |

**13 edge-wired · 45 to rewire · 16 nothing to do.**

> **This corrects PR #412's body**, which says "roughly 51 of 74 still reference
> the dead Java backend; 23 are already rewired". The 23 appears to count our
> authored files (13 `pages/intafaced/` + 3 `components/intafaced/` +
> `components/uc/IxHonestState.vue` + honesty rewrites such as
> `pages/cms/AboutUs.vue`) rather than files that make an edge call. Both numbers
> are defensible descriptions of different things; **45 is the size of the actual
> rewire queue**, because a file with no backend call needs no rewiring.

### 5.1 Already on the edge — 13, do not touch

`pages/intafaced/{Academy,Agents,Bank,Blueprint,Chain,Launch,P2P,Pay,Platform,Protocol,Token}.vue`,
`pages/intafaced/Dex.vue` (mixed — one residual `/exchange/` reference), and
`pages/otc/index.vue`.

> **`pages/otc/index.vue` is a live bug, not a rewire.** Lines 174 and 186 post to
> `this.host + '/api/advertise/excellent'`. `this.host` is `''`, so that leaves the
> browser as `/api/advertise/excellent` and the dev-server proxy routes `/api` to
> **svc-edge**, which has no such route — while the controller that serves it is
> `otc-api`'s, behind `/otc`. The intended path is `/otc/api/advertise/excellent`.
> It has been silently 404ing at the edge. **Size: S, fix it in the first P-UI PR.**

### 5.2 Nothing to do — 16

`components/exchange/{BZCountDown,DepthGraph,SvgLine,expand}.vue`,
`components/intafaced/{CommandPalette,IxState,SubAccountSelector}.vue`,
`components/otc/carousel.vue`, `components/uc/{IxHonestState,TradeExpand}.vue`,
`pages/activity/{Bzb,Partner}.vue`, `pages/cms/{AboutUs,Notice,WhitePaper}.vue`,
`pages/intafaced/NotBuilt.vue`.

### 5.3 The 45 to rewire, grouped by what each needs

**Group A — needs the ledger read (10 files).** Blocked on §4.1 item 10
(`AssetController` → `ledger.accounts`). Every one of these renders a balance.

| File                                | Java it calls                                   | Needs                                             |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `components/uc/MoneyIndex.vue`      | 7× `/uc/asset/*`                                | `/api/bank/trpc/…` or a ledger balances procedure |
| `components/uc/Account.vue`         | 8× `/uc/*`                                      | balances + identity                               |
| `components/uc/Recharge.vue`        | 6× `/uc/*`                                      | `pay.user-money` deposit (✅ done)                |
| `components/uc/Withdraw.vue`        | 9× `/uc/*`                                      | `withdrawHold` path via svc-pay                   |
| `components/uc/WithdrawAddress.vue` | 7× `/uc/*`                                      | address book — no ledger read                     |
| `components/uc/Record.vue`          | 2× `/uc/*`                                      | `ledger_entries` history                          |
| `components/uc/PayDividends.vue`    | 1× `/uc/*`                                      | `token.yield` (✅)                                |
| `pages/uc/MemberCenter.vue`         | **58× `/uc/*`** — the largest file in the shell | split before rewiring; do not do it in one PR     |
| `pages/ctc/Ctc.vue`                 | 12× `/uc/`, 2× `/market/`, 1× `/exchange/`      | blocked on §4.1 items 12–13                       |
| `App.vue`                           | 12× `/uc/`, 2× `/exchange/`, 3× `/otc/`         | session + nav; do this **first**, it gates auth   |

**Group B — needs OTC/P2P on the edge (8 files).** Blocked on §4.1 items 1, 2, 15.
`pages/otc/{AdPublish,Chat,CheckUser,Main,Trade,TradeInfo}.vue`,
`components/otc/{MyAd,Chatline}.vue`.
`svc-p2p` is `done` across offers/escrow/disputes/reputation, so most of this is
mapping tRPC shapes onto existing components rather than new backend work.
`Chatline.vue:179` also opens a SockJS socket at `/chat/chat-webSocket` — that is
the `chat` module (bucket 1), not svc-ws.

**Group C — needs identity on the edge (6 files).**
`pages/uc/{Login,Register,MobileRegister,FindPwd,IdentBusiness,AppDownload}.vue`.
`identity.*` is ✅ across seven rows. **This is the group that closes the "two
identity systems in one page" finding** (audit §3.5): today a user logs into the
Java `member` table via `/uc` and reads our balances via `/api`. Until this
group lands, "adopt the whole app" and "one book" are in visible conflict on
screen. **Do this group second, right after `App.vue`.**

**Group D — needs trade on the edge (7 files).**
`pages/exchange/Exchange.vue` (6× `/market/`, 2× `/exchange/`, 1× `/uc/`),
`pages/index/Index.vue`, `components/uc/{EntrustCurrent,EntrustHistory,myorder,MinTrade}.vue`,
`components/uc/InnovationOrders.vue`.
`trade.spot` ✅, `matching.engine` ✅, `ws.depth` ✅ — the backend is there. This
is the group that makes bucket 4's "delete the second matching engine" safe.

**Group E — content, and mostly it should NOT be rewired (6 files).**
`pages/cms/{Help,HelpDetail,HelpList,NoticeItem}.vue`,
`components/cms/Noticeindex.vue`, `pages/uc/AppDownload.vue`.
These call `/uc/announcement/*` and `/uc/aide/*` — **bucket 1 controllers that
work**. Adopt the backend (§3.2) and leave the screens alone. Rewiring them would
be building a CMS we do not have to replace one we already own. **Size: 0.**

**Group F — products with no decision (8 files).**
`pages/activity/{Activity,ActivityDetail}.vue`, `pages/envelope/Envelope.vue`,
`pages/invite/Invite.vue`, `components/uc/{InvitingMin,MyPromotion,PromotionMyCards,InnovationMinings}.vue`.
Blocked on the owner's answer in §6.3. Do not rewire a screen for a product
nobody has said we want.

### 5.4 Ownership and order

**P-UI = Nitro agents.** `docs/SHEHZAD-HARD-OWNERSHIP-2026-08-01.md:44` —
_"P-UI · Vendor shell `:8090` craft/hotkeys/honesty"_, and
`docs/BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md:16` scopes the lane to
`vendor/**/05_Web_Front/**` with `apps/web` and pay/protocol services explicitly
out.

Order: **`App.vue` → Group C (identity) → Group A (balances) → Group D (trade) →
Group B (OTC) → Group E (delete the task) → Group F (owner).**
`App.vue` first because it holds the session and the nav; every other group
renders inside it.

**Size: L** for the bucket. **S** per file for most of Groups B–D once the edge
procedure exists; **`pages/uc/MemberCenter.vue` alone is M–L** and should be
split before anyone starts.

---

## 6 · Bucket 4 — DELETE / DO NOT REVIVE

Every entry justified. "Do not revive" is not the same as "delete the files" —
where the second column says _quarantine_, the files stay and the door stays shut.

### 6.1 Delete outright

| What                                        |  Count | Why                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/**/*.jar` committed binaries        | **32** | `git ls-files "vendor/**/*.jar"` — `apns-http2-core`, `aqmd-netty-*`, `spark-core`, and 28 more. Unverifiable against any upstream or checksum, on the classpath of services that hold custody. ADR §4 says replace with Maven coordinates or remove. |
| `vendor/upstream-exchange/02_App_Android`   |  **2** | `.keep` + `README.md`. Already stripped. Nothing to read, nothing to adopt.                                                                                                                                                                           |
| `vendor/upstream-exchange/03_APP_IOS`       |  **2** | Same.                                                                                                                                                                                                                                                 |
| `vendor/upstream-exchange/06_ExchangeRobot` |  **2** | Same. And a trading robot is `trade.mm-bot`, which is ours and has non-negotiable seeded-liquidity rules (`DIRECTION-2026-07-31.md` §1).                                                                                                              |
| `00_framework/wallet/…/TestController.java` |  **1** | A test controller on a custody service. The audit already excluded it from the 94.                                                                                                                                                                    |

### 6.2 Quarantine — keep the files, keep the door shut

| What                                              |      Count | Why                                                                                                                                                                                                       |
| ------------------------------------------------- | ---------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/…/system/DividendController`               |      **1** | Mass credit in a loop over every holder — the exact shape `vendor-shell-scan` bans. `token.yield` ✅ and `rewardPay` + `sweepFeesToRewards` express it correctly, from a funded pot rather than thin air. |
| `admin/…/system/CoinController` hot-transfer path | **1 path** | `:387` writes a hot-wallet transfer record. Treasury movement on-chain is `svc-protocol` / `svc-pay`. Adopt the coin CRUD; leave this path until §8's review lands.                                       |

> **Moved out of this table by the owner's confirmation.**
> `01_wallet_rpc` (14 controllers) was quarantined here on the previous revision.
> **It is now in scope and has its own section — §8.** The owner named it
> explicitly, and the reasoning is sound: we have no chain custody of our own and
> building it is months. It is not, however, a simple adopt, and §8 says why.
>
> `exchange-api/…/OrderController` also left this table. It is not dead weight to
> quarantine — it is a working second implementation of something we already have,
> which makes it **bucket 5 · REPLACE** (§7.2). The distinction matters: a
> quarantined thing is one nobody should start, a replaced thing is one that
> **must never run at the same time as ours**.

### 6.3 Owner decides — do not build, do not delete, ask

Four products exist in the vendored tree, credit balances, have **no tracker row**,
and nobody has said we want them. The audit asked this on 30 July (§7.4 Q3) and it
is still unanswered. Building them costs recipe work in Denon's carve-out;
deleting them is, in the audit's own words, "the cheapest outcome available in
this whole document".

| Product             | Vendored surface                                                                                   | Screens |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| **Red envelope**    | `ucenter/RedEnvelopeController` (9 routes), `admin/redenvelope/*`, `admin/job/CheckRedEnvelopeJob` | 1       |
| **Activity / IEO**  | `admin/activity/ActivityController`, `ucenter/ActivityController`, `core/ActivityOrderService`     | 2       |
| **Sign-in bonus**   | `ucenter/MemberController.signInIncident:66`, `admin/activity/SignController`                      | —       |
| **Promotion cards** | `ucenter/PromotionController` (12 routes, `increaseFrozen:480`), `admin/promotion/*`               | 4       |
| **Mining orders**   | `ucenter/MiningOrderController`                                                                    | 2       |

> **One question, and it closes eight screens and six recipe proposals:**
> _do we want red envelopes, IEO activities, sign-in bonuses, promotion cards and
> mining orders as products?_ If no, they are neither adopt nor rebuild — they are
> delete, and Group F of §5.3 evaporates with them.

---

## 7 · Bucket 5 — REPLACE

**Placement rule:** ours substitutes for theirs, and **the two cannot both be
live**. Not because the vendored one is broken — because it works. Two working
implementations of one truth, both running, is the failure this bucket exists to
prevent.

I went looking for members of this bucket and expected to find one. **There are
four.** Two of them are hard preconditions of bucket 2 rather than follow-ups, and
neither has been named anywhere before.

### 7.1 Balances — the known one, and it is already done

`MemberWallet` + `MemberWalletDao` + `MemberWalletService` + the
`member_wallet_history` `AFTER UPDATE` trigger, replaced by `ledger.*`.

Settled by the ADR (`Status: Accepted`, Option B) and **executed** by #234 and
#289: DAO mutators no-op'd, 50 URI fragments behind a 410 interceptor,
`vendor-java-money-scan` in CI over 882 Java files. Nothing further to decide.
The remaining work is bucket 2 — reopening each door behind an adapter.

**One residual, and it is a schema change with a deadline:** `member_wallet.balance`
is `decimal(18,8)`; `ledger.accounts.balance` is `numeric(38,18)`. Widen to
`decimal(38,18)` **before the first adapter ships**, not after (§4.2).

### 7.2 The matching engine and the exchange order book

`00_framework/exchange` (the matching module) + `exchange-core/ExchangeOrderService`
(8 mutator call-sites) + `exchange-api/…/OrderController` (`/order/add:74`,
`/order/cancel/{orderId}:415`).

**Why replace rather than adapt.** This maps perfectly onto `orderHold` /
`orderHoldRelease` / `tradeFill` — and that is precisely the argument against
adapting it. `matching.engine` ✅ and `trade.spot` ✅ already do it, tested,
deterministic, against our book. Adopting a second matcher would be the one place
where "adopt everything" costs us something we already do better.

**Why it is not merely quarantine.** `intafaced-cx-exchange` is **Up 2 days
right now** — it is the only vendored module still running. It is idle only
because `exchange-api` cannot reach it and no order has ever been placed. Bring
`exchange-api` back per §2.3 and there are two matching engines on one machine.
`/order/add` must stay in `BLOCKED_URI_FRAGMENTS` **through and after** §2.3, and
that is easy to forget precisely because §2.3 is framed as "make things run".

Keep the screen (`pages/exchange/Exchange.vue`, §5.3 Group D). Replace the engine.

### 7.3 User identity — and this one blocks bucket 2 outright

**Nobody has decided this, and bucket 2 cannot start until somebody does.**

Every ledger account is keyed on a user id:

```ts
// packages/ledger-client/src/accounts.ts:11
export function userAvailable(userId: string, assetId: string): AccountRef {
  return { ownerType: 'user', ownerId: userId, assetId, kind: 'available' };
}
```

The two systems key users in **disjoint namespaces**:

| System                     | Type                              | Evidence                                    |
| -------------------------- | --------------------------------- | ------------------------------------------- |
| `identity.users.id`        | `uuid`, `defaultRandom()`         | `services/svc-identity/src/db/schema.ts:23` |
| `member.id`                | `Long`, `GenerationType.IDENTITY` | `…/core/…/entity/Member.java:27-29`         |
| `ledger.accounts.owner_id` | **`text`** — accepts either       | `services/svc-ledger/src/db/schema.ts:32`   |

**Read the third row carefully. `owner_id` is `text`, so a wrong adapter does not
fail.** It creates a second, valid, non-negative, sum-to-zero-conformant account
for the same human under the other namespace — and every gate we have reports
clean, because nothing is unbalanced. That is the exact silent-and-unreconcilable
shape the ADR was written to prevent, arriving through a door the ADR did not
look at.

The audit filed identity under "genuinely ambiguous" and asked the owner _"does a
person's account live in `identity.users` or in `member`?"_ **The balance decision
answered it and nobody noticed.** If `ledger.*` is the only book, and every ledger
account is keyed on a user id, then the id that keys the book is the id of record.
**`identity.users` is authoritative; `member` becomes a projection or a join
table.** That is not a new decision — it is the one already taken, followed
through.

**What must exist before the first adapter posts anything:** a single resolution
point that maps a vendored `member.id` to an `identity.users.id`, that **refuses**
rather than inventing when there is no mapping. A `NOT NULL` join column on
`member`, or a lookup in the adapter — either is fine; a fallback that mints an id
is not. And `identity.users` currently holds ~7,192 rows of test pollution
(audit §3.4), so the mapping must be built against a cleaned table or it will map
real people onto test residue.

**Size: M. Owner: M5 (`identity money graph`) = shehzad002.** It is his lane by
`SHEHZAD-HARD-OWNERSHIP-2026-08-01.md:37` — _"M5 Identity money graph ·
sub-accounts / money-adjacent gates"_ — and this is the most money-adjacent gate
in the tree.

### 7.4 Schema management — `ddl-auto=update` is a replacement, not a config line

The ADR's first finding, still unaddressed: **the repository contains no database
schema.** Nine `CREATE TABLE` statements in the whole tree; `exchange_order`,
`member` and `member_transaction` are defined nowhere. What creates the tables is:

```
admin/…/dev/application.properties:65        spring.jpa.hibernate.ddl-auto=update
exchange/…/dev/application.properties:55     spring.jpa.hibernate.ddl-auto=update
market/…/dev/application.properties:11       spring.jpa.hibernate.ddl-auto=update
ucenter-api/…/dev/application.properties:136 spring.jpa.hibernate.ddl-auto=update
```

— live in four modules, across 63 `@Entity` classes.

**Why this is bucket 5 and not a nit.** `ddl-auto=update` never drops and never
narrows. It is the mechanism by which dev, staging and production end up with
different schemas **and nothing reports it**. Today that is harmless: the tables
hold zero rows. The moment bucket 2 lands and `member_wallet` becomes a
projection of the ledger, a silently divergent column is a projection that
disagrees with the book on one environment only — which is indistinguishable, from
inside, from the ledger being wrong.

We already have the replacement and it is enforced: `pnpm db:migrate` plus
`tooling/ci/migration-check.mjs` (`db:check`). The vendored schema has to come
under it — generate the DDL once from a booted instance, commit it as a migration,
set `ddl-auto=validate`, and let a mismatch **refuse to boot** instead of
silently patching itself.

**Size: M. Owner: tooling/CI = Denon**, alongside §2.4's build story — same
problem shape (the artefact that makes the system reproducible does not exist).

### 7.5 And nothing else — which is the useful part

I checked the remaining candidates and none of them belongs here:

| Candidate                    | Verdict  | Why not REPLACE                                                                                                                                                                       |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Market data** (`market`)   | bucket 1 | Seeded and synthetic (`volume: 0.0000`), ours is honestly-empty. Both can run; only the labelling has to be honest. Adopt with the caveat, do not replace.                            |
| **Kafka vs NATS**            | neither  | The vendored stack's Kafka is internal to it; the adapter boundary is HTTP + `ledger-client`, not the bus. Two buses is untidy, not dangerous. No truth is duplicated across them.    |
| **Sessions** (Redis, `/uc`)  | bucket 3 | Resolved by rewiring §5.3 Group C onto `identity.*`, not by replacing a subsystem. The Java session store simply stops being used.                                                    |
| **CMS / RBAC / statistics**  | bucket 1 | We have no implementation to substitute. Nothing to replace with.                                                                                                                     |
| **P2P / OTC escrow**         | bucket 2 | Genuinely overlapping — but the vendored side has the better product (advert-level inventory locks, §4.1 item 15). Adapt theirs, extend ours. Replacing here would lose a capability. |
| **KYC / identity documents** | bucket 1 | `identity.kyc` ✅ exists, but the vendored flow is a _screen_ flow over ours. Rewire, not replace.                                                                                    |
| **`01_wallet_rpc`**          | §8       | We have **no** chain-custody implementation at all. There is nothing to substitute — which is exactly why the owner adopted it, and exactly why §8 is the riskiest page here.         |

**So bucket 5 has four members: balances (done), the matching engine, user
identity, and schema management.** Two are already decided and executing. The
other two — §7.3 and §7.4 — are load-bearing preconditions that were not on
anyone's list, and §7.3 blocks the first bucket-2 adapter.

---

## 8 · `01_wallet_rpc` — adopted, and the security review is a precondition

The owner named this explicitly and the reasoning holds: **we have no chain
custody of our own.** `svc-protocol` is smart accounts, `svc-dex` is quotes,
`svc-indexer` is read models — none of them holds a key that signs a withdrawal.
Building that is months. Adopting a working thirteen-chain wallet layer is the
right call, and this section is not an argument against it.

It is a statement of what must happen first — and a first read found enough that
"first" is not negotiable here in the way it is nowhere else in this document.

### 8.1 What it is, counted

| Measure                              | Value                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Maven modules declared               | **15** in `01_wallet_rpc/pom.xml:13-28`                                                                        |
| Maven module directories on disk     | **14** — **`<module>xrp</module>` (`pom.xml:21`) points at a directory that does not exist and is not in git** |
| Controllers                          | **14** — 13 per-chain `WalletController` + `rpc-common/RpcController`                                          |
| `.java` files                        | **215** (205 under `src/main`, 10 tests)                                                                       |
| Lines of Java                        | **13,224**                                                                                                     |
| Chains                               | BTC, BCH, BSV, LTC, XMR, ETH, ERC-20, USDT-ERC20, USDT-Omni, EOS, BTM, ACT, ECT — **XRP declared, absent**     |
| Exchange-side counterpart            | `00_framework/wallet` — 8 `.java` files, jar built, never started                                              |
| Committed `.jar`s in `01_wallet_rpc` | **18 files, 3 distinct artefacts** (32 jars across the whole vendored tree)                                    |

**It does not touch the book.** `grep -rl "MemberWallet\|member_wallet" 01_wallet_rpc`
returns **nothing** — a separate Maven tree under `com.upstream.bc.wallet` that
speaks only to chain nodes and Kafka. Adopting it creates **no** second set of
books, and none of §4's adapter work applies. **The entire risk here is private
keys, and none of it is dual-book.** The gates we built for §4 do not help here
and were never meant to.

> A reactor build from `01_wallet_rpc/pom.xml` fails on the missing `xrp/pom.xml`.
> `c221cc8`'s "14/14 modules green" is consistent with building the fourteen that
> exist, not the fifteen declared. §2.4's build story has to know this.

### 8.2 It has been read once, and the ADR is stale — but not in the reassuring direction

The ADR says `01_wallet_rpc` _"has not been read."_ **Someone read it on 29 July.**
`c221cc8` — _"merge: shut the wallet RPC, remove the live trading backdoor"_ —
touched 39 files, +468/−594, and its message is the most valuable security
document in the repository:

> _"All 13 wallet RPC services exposed `GET /rpc/withdraw?address=X&amount=Y`, and
> there was no interceptor, no filter and no security config anywhere in
> `01_wallet_rpc` — a grep of the whole tree for auth infrastructure returned zero
> files. **Anyone who could open a socket to the port drained the hot wallet with
> no credential.**"_

Plus two more P0s: `987654321asdf` was a live auth bypass listed in
`excludePathPatterns` (reaching place/cancel orders as uid 1, crediting an
arbitrary member's wallet, rewriting a pair's price limits), and
`GET /smstest/drop` ran `TRUNCATE TABLE member_wallet_*`.

**What it added, verified on disk:** `rpc-common/…/config/RpcAuthInterceptor.java`
(77 lines, `X-Rpc-Auth-Token`, constant-time compare at `:55-66`),
`rpc-common/…/config/RpcSecurityConfig.java` (48 lines, `@Value("${rpc.auth-token}")`
at `:27`, `@PostConstruct` refusing blank or `< 32` chars at `:31-41`,
`addPathPatterns("/**")` at `:45`), and
`eth-support/…/config/KeystorePasswordValidator.java` (48 lines).

**"Deliberately shut" was never the right description.** A second read confirms:
`git diff a19e337 HEAD -- vendor/upstream-exchange/01_wallet_rpc` is 36 files,
+447/−204, and **every change is additive hardening or a literal→placeholder
swap. Nothing in this tree is no-op'd** the way `MemberWalletDao` was. Key
generation, every block watcher and its thread, Kafka deposit publication, ETH
and ERC-20 signing and broadcast, the BTC/USDT node send paths, and both
`@Scheduled` sweep jobs are **live code**. Started with the env vars set, this
generates keys and broadcasts real transactions.

### 8.3 Six of the fourteen modules have no authentication at all

**This is the finding to act on, and it is not recorded anywhere.**

`RpcAuthInterceptor` and `RpcSecurityConfig` exist in exactly one place —
`rpc-common`. A module only gets them if `rpc-common` is on its classpath.
Checking every `pom.xml`:

| Auth enforced (8)                              | How                            |
| ---------------------------------------------- | ------------------------------ |
| `act`, `bitcoin`, `ect`, `usdt`, `eth-support` | direct `rpc-common` dependency |
| `eth`, `erc-token`, `erc-eusdt`                | transitive via `eth-support`   |

| **No auth (6)**                          | Evidence                                               |
| ---------------------------------------- | ------------------------------------------------------ |
| `bch`, `bsv`, `btm`, `eos`, `ltc`, `xmr` | `grep -c rpc-common <module>/pom.xml` → **0** for each |

Each of the six carries its own duplicated copies of `CoinConfig`,
`KafkaConfiguration`, `MongodbConfig`, entities and services — but **no copy of
`RpcSecurityConfig` or `RpcAuthInterceptor`** (`find -name RpcSecurityConfig.java`
returns exactly one path, in `rpc-common`).

So their `rpc.auth-token=${WALLET_RPC_AUTH_TOKEN}` line — `bch:41`, `bsv:41`,
`btm:51`, `eos:46`, `ltc:42`, `xmr:42` — **is read by nothing.** No `@Value`
binds it, so the placeholder never has to resolve, the `@PostConstruct` guard
never runs, and **these six start happily with no token and serve `/rpc/**`
unauthenticated.**

**What that exposes.** No funds move — the withdraw handlers on `bch:146`,
`bsv:146`, `ltc:142`, `btm:142` are upstream stubs returning
`MessageResult.error(500, "暂未实现该功能")`, confirmed present in the original
import. But `GET /rpc/address/{account}` on `bch`, `bsv` and `ltc`
**generates a new EC private key and writes it into the wallet file** (§8.4b),
unauthenticated. That is an unauthenticated mutation of key material and an
unbounded-growth vector on the file that holds every key.

**And it corrects a document we are relying on.**
`docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md:162-165` states:

> _"The auth wall from #86 is real and enforced — `RpcSecurityConfig` registers
> `RpcAuthInterceptor` on `/**` … and refuses to start if the token is unset or
> shorter than 24 characters. **Confirmed by reading the code, not by running
> it.**"_

It is real and enforced **on eight modules and absent on six**, and the threshold
is **32**, not 24 (`RpcSecurityConfig.java:25`). A1.4 read `rpc-common` and
generalised. That is exactly the failure mode `c221cc8` itself named — _"a guard
was written, then bypassed by a second door"_ — and it recurred inside the fix.

**Remediation is small and must land before any of this starts:** add the
`rpc-common` dependency to the six `pom.xml`s, and add a startup assertion that
fails if the interceptor is not registered, so a future module cannot omit it
silently. **Size: S. But it is not the review** — it is one hole found by one
pass, which is the argument for §8.6, not a substitute for it.

### 8.4 How keys are generated and stored — five different models, no BIP-anything

`grep` for `Bip39|Bip44|DeterministicSeed|mnemonic|createEcKeyPair` across
`01_wallet_rpc` returns **zero hits.** There is no HD derivation, no seed, no
mnemonic. There are five unrelated custody models:

**(a) ETH family — web3j scrypt keystore files on local disk** (`eth`, `erc-token`, `erc-eusdt`)

```java
// 01_wallet_rpc/eth-support/…/service/EthService.java:58-66
String password = requireKeystorePassword();
String fileName = WalletUtils.generateNewWalletFile(password, new File(coin.getKeystorePath()), true);
Credentials credentials = WalletUtils.loadCredentials(password, coin.getKeystorePath() + "/" + fileName);
```

Written to `coin.keystore-path=/data/eth/data/keystore` (`eth:27`, `erc-token:24`,
`erc-eusdt:24`); the **filename** is indexed in MongoDB
(`rpc-common/…/service/AccountService.java:96-103`), not the key. Password is
`${ETH_KEYSTORE_PASSWORD}` with no default, enforced twice (`EthService.java:87-93`
and `KeystorePasswordValidator.java:32-47`). Hot withdrawal wallet is a separate
`${ETH_WITHDRAW_WALLET_PASSWORD}` (`EthService.java:98-104`). **Before `c221cc8`
the withdraw password was the committed literal `fdsafdsafdsafdsa` and three call
sites passed `""` as the keystore password.**

**(b) BCH / BSV / LTC — raw `ECKey` into an _unencrypted_ bitcoinj wallet file**

```java
// 01_wallet_rpc/bch/…/controller/WalletController.java:41-74  (identical bsv:41-74, ltc:41-73)
Wallet wallet = Wallet.loadFromFile(walletFile);
ECKey key = new ECKey();
wallet.importKey(key);
wallet.saveToFile(walletFile);
```

**No password anywhere on this path** — no `encrypt()`, no `KeyCrypter`. Paths are
literals: `/data/bch/bch.wallet` (`bch:25`), `/data/bsv/bsv.wallet` (`bsv:25`),
`/data/ltc/ltc.wallet` (`ltc:25`). Private keys sit in a plaintext protobuf file.
Upstream code, unchanged by the fork — **and these are three of the six modules
with no auth (§8.3)**.

**(c) BTC / USDT — delegated to the node's own wallet.** `rpcClient.getNewAddress(account)`
(`bitcoin:43`, `usdt:48`); keys live in `bitcoind`/`omnicored`, reached through an
RPC URL that embeds `user:pass` (`${BTC_NODE_RPC_URL}`, `${USDT_NODE_RPC_URL}`).
`rpc-common/…/util/WalletOperationUtil.java:18-29` wraps `walletpassphrase` /
`walletlock` and **has zero callers**; correspondingly `coin.password=${USDT_WALLET_PASSWORD}`
(`usdt:32`) is **dead config** — the `Coin` entity has no `password` field. So the
node wallet is never explicitly locked by this code.

**(d) ECT — the withdrawal secret key is a committed plaintext literal.** This is
the worst thing in the tree and it is still live:

```properties
# 01_wallet_rpc/ect/src/main/resources/application.properties:14
coin.withdraw-wallet=shxgAaZZGqaU9QdfedQvejadpGEqy
```

That is not a filename. It is the first argument to `EctApi.sendFrom(...)`, whose
parameter is declared `String privatekey` (`EctApi.java:118-121`), and it is
`POST`ed as `"secret"` to a **remote HTTP API** (`EctApi.java:134`), default host
hardcoded at `EctApi.java:17`. A second XRP-family secret is hardcoded in a
`main()` at `EctApi.java:152`. **`ect` was left out of the placeholder sweep
entirely** — `:7` still carries a literal `mongodb://…` and `:9` a literal
`coin.rpc`. The values look hand-mangled by the upstream vendor, so they may be
inert; **structurally they are secrets in tracked files and must be treated as
burned.**

**(e) BTM / EOS / XMR / ACT — no local keys.** BTM is node-side behind
`${BYTOM_CLIENT_ACCESS_TOKEN}` + `${BYTOM_WALLET_PASSWORD}` (`btm:30,36`); ACT
derives `masterAddress + UUID` with no key at all (`act:44-45`); EOS/XMR are a
single deposit address plus memo. The EOS controller has **no endpoints at all** —
37 lines of fields.

**Other credential literals still in tracked files:**

| File:line                                                | What                                                   |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `01_wallet_rpc/act/src/test/…/ActClientTest.java:10`     | node RPC `user:pass` against a **real public IP**      |
| `01_wallet_rpc/usdt/…/config/JsonrpcClient.java:163`     | `http://bitcoin:bitcoin@127.0.0.1:8888/` in a `main()` |
| `00_framework/wallet/…/dev/application.properties:12-13` | literal MySQL **root** credential                      |
| `00_framework/wallet/…/dev/application.properties:78-79` | commented-out Elasticsearch credential                 |

### 8.5 The deposit pipeline runs to completion and then throws

This is the operational trap, and it is worth stating precisely because it looks
like a safety property and is not.

**Deposit:** poller thread (`rpc-common/…/event/ApplicationEvent.java:34-58`) →
per-chain scanner (`eth/…/EthWatcher.java:39-82`, `usdt/…/UsdtWatcher.java:27-58`)
→ Mongo dedupe → `kafkaTemplate.send("deposit", …)`
(`rpc-common/…/event/DepositEvent.java:24-30`) → exchange-side
`@KafkaListener(topics={"deposit"})` → `walletService.recharge(...)`
(`00_framework/wallet/…/consumer/FinanceConsumer.java:47-78`).

**That last call now throws.** `00_framework/core/…/service/MemberWalletService.java`
`:86-90`, `:101-104`, `:115-118` — all three `recharge` overloads:
`throw new IllegalStateException("recharge is disabled: Java shell must not credit balances (INTAFACED dual-book)")`.

So if this stack is started: **coins are swept into hot wallets, recorded in
Mongo, published to Kafka — and then the credit step explodes.** On-chain funds
with no book entry, and a Kafka topic accumulating deposits nobody is applying.
The dual-book guard is doing its job at the book; it is not stopping the chain
side, because the chain side is not the book.

**Withdrawal is worse, in that it is not gated by the dual-book work at all.**
`FinanceConsumer.handleWithdraw` (`:85-123`) builds
`http://SERVICE-RPC-{UNIT}/rpc/withdraw?address={1}&amount={2}&fee={3}` (`:94-95`)
and calls it over a Eureka-load-balanced `RestTemplate` (`:101`). Signing:
`TransactionEncoder.signMessage` (`eth-support/…/PaymentHandler.java:123`, ERC-20
at `:160`), `BitcoinUtil.sendTransaction` inside bitcoind (`bitcoin:62`),
`rpcClient.omniSend` inside omnicored (`usdt:60`), and ECT's remote-secret POST
(`ect:47`). **The only things standing between a Kafka `withdraw` message and a
broadcast transaction are `WALLET_RPC_AUTH_TOKEN` and a database boolean**
(`coin.getCanAutoWithdraw() == BooleanEnum.IS_TRUE`, `FinanceConsumer.java:99`).

**Both facts belong in the adoption plan as ordering constraints:** the deposit
callback must be re-pointed at our `deposit` recipe (§4.1's rail pattern) before
any address is issued, and the withdraw path must not be reachable before §8.3
and §8.6 are done.

### 8.6 What the review must still establish

Three P0s were found by one person reading with one question in mind. §8.3 found
a fourth by asking a different one. Neither `c221cc8` nor this document claims
the tree is clean — `c221cc8` fixed what it found, which is not the same thing.
The review must establish, with evidence:

1. **The six unauthenticated modules are closed** (§8.3), and a startup assertion
   makes the omission impossible to repeat.
2. **Every secret that was ever committed is rotated, not re-used.** `c221cc8`
   says keystore passwords _"were previously committed in plaintext"_ and
   `getNewAddress` _"took the password as a request parameter and logged it at
   INFO"_. **Removing a secret from HEAD removes it from neither git history nor
   logs.** ECT's `:14` literal is still at HEAD. `DIRECTION-2026-07-31.md` §8.2
   already reserves the disclosed-secret-in-history problem to the owner.
3. **The BCH/BSV/LTC unencrypted wallet files get a `KeyCrypter`**, or those
   chains do not list. A plaintext key file is not a finding to note; it is a
   decision to take.
4. **ECT is either rewritten to hold its secret out of the tree, or dropped.**
   Sending a raw private key to a third-party HTTP endpoint is not something a
   config change fixes.
5. **The 18 jars on this tree's classpath are traced to a provenance.** Only 3
   distinct artefacts, and the exposure is ranked: `bitcoin-rpc-1.2.0.jar` in
   `rpc-common/lib` is a compile dependency of `eth-support` and therefore in the
   **same JVM as decrypted ETH `Credentials`**; `litecoinj-core-0.15.20190219.jar`
   in `ltc/lib` is the code that _generates_ the `ECKey`; and
   `bitcoinj-core-0.13-alice-SNAPSHOT.jar` (1.4 MB, in `ltc/lib` and `xmr/lib`) is
   **referenced by no `pom.xml` at all** — orphaned unreviewed bytecode. None can
   be verified against an upstream or a published checksum (ADR §4). **A binary of
   unknown provenance on a signing service's classpath is not a code-quality
   issue; it is the whole threat model.**
6. **The node RPC perimeter.** `${BTC_NODE_RPC_URL}` and `${USDT_NODE_RPC_URL}`
   embed credentials, and `WalletOperationUtil` is never called so the node wallet
   is never re-locked. Whether that is acceptable depends on where the node sits.
7. **Whether a shared bearer token is the right control at all.** It is right for
   a service-to-service call on a private network and insufficient anywhere else.
   §2.3's compose work must bind these to an internal network — and per §8.7 it
   must not add them yet.

### 8.7 The rule

**A security review is a precondition of adoption, not a follow-up.**

Not process theatre. This is the only bucket in the document where being wrong is
**irreversible and external**. Everywhere else a mistake produces a wrong number
we can reconstruct from the journal. Here it produces a drained hot wallet, and
there is no posting that reverses an on-chain transfer. §6 of the audit made this
argument about adopting a `member_wallet` writer; it applies with far more force
to adopting a signer.

The gates, concretely:

- **No `01_wallet_rpc` module enters a compose file before the review reports.**
  §2.3 adds `exchange-api`, `otc-api`, `chat` and `admin`. **It must not add
  these**, and the six from §8.3 must not be started even on a private network.
- **No agent touches this tree.** Signing-key custody is the owner's by
  `DIRECTION-2026-07-31.md` §8.3.
- **`WALLET_RPC_AUTH_TOKEN`, every keystore password, and every node RPC
  credential are Class X** — §8.2, secrets are the owner's.
- **`custody-scan` does not cover this and must not be stretched to.** It is a
  Protocol-Plane-imports gate over four TypeScript services (§1.2). What is needed
  here is different in kind: a scan that fails on a private key, mnemonic or
  keystore password in any tracked file — **ECT `:14` would fail it today** — and
  on any `excludePathPatterns` entry in the wallet tree, because that is exactly
  the mechanism the `987654321asdf` bypass used. **Write the right gate; do not
  widen the wrong one.**

### 8.8 Sizing the review honestly

**XL, and it is the longest pole in the programme.** 13,224 lines across 215
files and 13 chain integrations, each with its own node protocol and — as §8.4
shows — its own unrelated custody model. There is no shared abstraction to review
once.

The basis for calling it XL rather than a number pulled from nowhere: the two P0s
found in our own TypeScript this week were each _"a guard was written, then
bypassed by a second door"_ (ADR, "Not yet done"). `c221cc8` found that shape
here twice, and §8.3 found it a third time **inside `c221cc8`'s own fix**. So
this cannot be sampled. The per-chain modules must each be read, because the
bypass lives in the one that was not.

| Piece                                      | Size         | Note                                                                                                      |
| ------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------- |
| `rpc-common` + `eth-support` (1,933 lines) | **M**        | Read first — everything else inherits it                                                                  |
| Per-chain read × 13                        | **S–M each** | Parallelisable. `btm`/`bch`/`bsv`/`ltc`/`xmr`/`eos` are ~1,400 lines each; `bitcoin`/`ect`/`act` ~250-310 |
| Jar provenance — 3 artefacts, 18 copies    | **M**        | Honest outcome for at least one is "cannot be established" → removal                                      |
| Git-history secret sweep + rotation plan   | **S–M**      | What was committed, when, what must rotate                                                                |
| Adversarial second-door pass               | **L**        | By someone who did not do the first read                                                                  |

**Start it now, in parallel with §2** — it is item 7 in §9.2 for that reason, not
because it comes seventh.

**The honest caveat on my own sizing.** This section rests on a targeted read —
the hardening commit, the two config classes, every `pom.xml`, every
`application.properties`, and the key-handling and withdrawal call sites. **It is
not a security review and must not be cited as one.** 215 files were not read
line by line. The number that matters is the one the reviewer gives after the
`rpc-common` + `eth-support` read, which is the cheapest useful checkpoint. That
§8.3 exists at all — a hole in the fix, found by reading `pom.xml` files rather
than Java — is the strongest evidence available that the deeper read will find
more.
---

## 9 · Effort, order, ownership

### 9.1 Sizing

| Bucket                                       | Size   | Why                                                                             |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| **§2 FIX FIRST** — mongo, redis, compose     | **M**  | Two S config fixes + four compose blocks + the Maven build story (§2.4).        |
| **§2.4 reproducible jar build**              | **M**  | Independent of the rest; unblocks CI ever touching Java.                        |
| **§1.2 scans into `pnpm verify`**            | **S**  | One line. Highest leverage in the document.                                     |
| **Bucket 1 — adopt 68 controllers**          | **M**  | Almost entirely §2. Each module after the first is a copy-pasted compose block. |
| **Bucket 1 — tracker rows for the six gaps** | **S**  | Data edit. Blocked today — see §9.4.                                            |
| **Bucket 2 — 11 exact adapters**             | **L**  | Each is S–M; there are eleven and every one is money.                           |
| **Bucket 2 — ~6 new recipes**                | **M**  | One reviewed PR, Denon, ahead of the adapters.                                  |
| **Bucket 2 — 8 gap controllers**             | **L**  | Blocked on the recipes and on §6.3.                                             |
| **Bucket 2 — `decimal(38,18)` widening**     | **S**  | One DDL change. **Must precede the first adapter.**                             |
| **Bucket 3 — merge #412**                    | **S**  | Already written, already validated. Just needs merging.                         |
| **Bucket 3 — rewire 45 screens**             | **L**  | `MemberCenter.vue` alone is M–L. Split it.                                      |
| **Bucket 4 — deletes**                       | **S**  | 39 files, no logic.                                                             |
| **Bucket 4 — owner decision**                | **—**  | Not engineering.                                                                |
| **§7.2 — keep `/order/add` shut**            | **S**  | One line NOT deleted. The risk is forgetting it during §2.3.                    |
| **§7.3 — identity id resolution**            | **M**  | **Blocks the first bucket-2 adapter.** M5 = shehzad002.                         |
| **§7.4 — vendored schema under migrations**  | **M**  | Same shape as §2.4: `ddl-auto=validate` + a committed migration.                |
| **§8 — `01_wallet_rpc` security review**     | **XL** | 215 Java files, 13 chains, private keys, 32 unverifiable jars.                  |
| **§8 — wallet RPC adoption after review**    | **L**  | Cannot be sized honestly until the review says what survives it.                |

### 9.2 Suggested order

The ordering rule: **make it runnable, make it honest, make it ours, then make it
move money.**

1. **Merge #412.** The shell has never been deployable. Every other item in
   bucket 3 is invisible until it is. _(S · agents)_
2. **§1.2 — five scans into `pnpm verify`.** Before anyone starts, make "verify
   green" mean something. _(S · Denon)_
3. **§2.1 + §2.2 — mongo pin, redis password.** Two config lines bring `market`
   and `ucenter` back and take reachable controllers from 1 to ~15. _(S · Denon)_
4. **§2.3 — `otc-api`, `exchange-api`, `chat`, `admin` into compose.** Takes
   reachable controllers to ~68 and makes bucket 1 real. _(M · Denon)_
5. **§2.4 — a reproducible Maven build.** Otherwise steps 3–4 are true on one
   laptop. _(M · Denon)_
6. **Tracker: six rows** — CMS, site-content, red-envelope, activity, CTC, and
   **the shell itself**. Until these exist agents keep rebuilding them. _(S ·
   P-TRACK, after #346 — see §9.4)_
7. **§8 — commission the wallet RPC security review.** It is XL and it is the
   longest pole in the whole programme, so it starts **now**, in parallel, not
   when everything else is finished. Nothing downstream of it can begin until it
   reports. _(XL · owner commissions; see §8)_
8. **§7.3 — decide and build the identity id resolution.** `identity.users` is
   authoritative; build the refusing mapping. **The first bucket-2 adapter cannot
   be written before this.** _(M · M5 = shehzad002)_
9. **§4.1 item 10 — `AssetController` reads `ledger.accounts`.** The single
   highest-value change in the document: it ends "two balance systems in one
   page". _(S · M7)_
10. **Bucket 3 `App.vue` → Group C (identity).** Ends "two identity systems in one
    page". _(M · P-UI)_
11. **`decimal(18,8) → decimal(38,18)`.** Before any adapter. _(S · M7)_
12. **§7.4 — vendored schema under `db:migrate`, `ddl-auto=validate`.** Before
    `member_wallet` becomes a projection anyone reads. _(M · Denon)_
13. **Denon's recipes PR** — `p2pOfferHold/Release`, `merchantBondLock/Release/Forfeit`.
    _(M · Denon)_
14. **Bucket 2 exact adapters, in this order:** withdraw (items 3+4, the pair) →
    OTC order + appeal (items 1+2) → fiat rails (5–7) → transfer (9) → CTC (12+13)
    → operator credit (8, behind dual-control). _(L · M7)_
15. **Bucket 3 Groups A, D, B** as their backends land. _(L · P-UI)_
16. **Bucket 4 deletes.** _(S · agents)_
17. **§6.3 owner decision**, then Group F lives or dies. _(— · owner)_
18. **Wallet RPC adoption** — only if and as §8's review permits. _(L · owner + M2)_

Steps 1–6 are entirely non-money and can run fully parallel with steps 7+.
**Step 7 must not wait for steps 1–6.** It is the item most likely to determine
whether the chain-custody half of the owner's direction is achievable at all, and
it is the one with the longest lead time.

### 9.3 Ownership — mapped to the lanes that exist

| Bucket / item                                   | Lane                      | Who              | Authority                                                    |
| ----------------------------------------------- | ------------------------- | ---------------- | ------------------------------------------------------------ |
| §2 compose, mongo, redis, Maven build           | **tooling / CI**          | **Denon**        | `AGENTS.md` "Denon-only infra"                               |
| §1.2 scans into `verify`                        | **tooling / CI**          | **Denon**        | same                                                         |
| New ledger recipes (§4.1 ✖ group)               | **direction / spine law** | **Denon**        | `DIRECTION-2026-07-31.md` §3 Class M carve-out               |
| Bucket 1 — start modules, adopt non-money       | **P-P5-LIGHT / ops thin** | **Nitro agents** | `SHEHZAD-HARD-OWNERSHIP:44`                                  |
| Bucket 1 — tracker rows                         | **P-TRACK**               | **Nitro agents** | same                                                         |
| **Bucket 2 — every money adapter**              | **M7**                    | **shehzad002**   | `SHEHZAD-HARD-OWNERSHIP:39,190` · `AGENTS.md:13`             |
| Bucket 3 — all 45 screens + #412                | **P-UI**                  | **Nitro agents** | `BOARD-CLEAR-AGENT-BACKLOG:16` (`vendor/**/05_Web_Front/**`) |
| Bucket 4 — deletes                              | **P-UI / P-TRACK**        | **Nitro agents** | non-money vendor tree                                        |
| Bucket 4 — §6.3 product decision                | **owner**                 | **Nitro human**  | `DIRECTION-2026-07-31.md` §8                                 |
| Kill-switch / posting-freeze semantics (item 8) | **Denon §3 carve-out**    | **Denon**        | "touches a posture gate, kill-switch, or custody scan"       |
| **§7.2 — matching engine stays shut**           | **M7**                    | **shehzad002**   | vendor Java money doors                                      |
| **§7.3 — identity id resolution**               | **M5**                    | **shehzad002**   | `SHEHZAD-HARD-OWNERSHIP:37` — "money-adjacent gates"         |
| **§7.4 — schema under migrations**              | **tooling / CI**          | **Denon**        | same lane and same shape as §2.4                             |
| **§8 — wallet RPC security review**             | **owner commissions**     | **Nitro human**  | signing-key custody is `DIRECTION-2026-07-31.md` §8.3        |
| **§8 — wallet RPC adoption, post-review**       | **M2 Protocol OS**        | **shehzad002**   | `SHEHZAD-HARD-OWNERSHIP:34` — self-custody stack             |

**The two things agents must not do:** implement bucket 2 (`AGENTS.md:13`, M7 is
claimed), and touch `01_wallet_rpc` (§8 — private keys, and signing-key custody
is reserved to the owner by `DIRECTION-2026-07-31.md` §8.3). Agents write the
specs, the tests and the adapter design; shehzad002 opens the doors; the owner
commissions the review.

### 9.4 Tracker rows — warranted, but not by this PR

`node tooling/ci/claim-check.mjs` against the three paths this work would touch:

```
claim-check — 3 path(s) from arguments, against 4 open PR(s)
✖ 1 open PR(s) are already inside these paths:
    #346 @shehzad002 — feat(pay): M1 pay.gateway Done bar
        · tooling/tracker/features.mjs
```

`docs/UPSTREAM-ADOPTION-QUEUE-2026-08-02.md` and `docs/LIVE-LANES.md` are free;
**`tooling/tracker/features.mjs` is inside @shehzad002's open #346.** Editing it
here creates a merge conflict on a human-claimed money PR — the exact thing
claim-check exists to prevent, and `AGENTS.md`'s "tracker touch = mountain events
only" says a docs PR is not the event that earns it.

**So the six rows are specified here and filed after #346 lands**, as one P-TRACK
edit:

| Proposed id        | Title                                                  | Module     | Phase | Status          |
| ------------------ | ------------------------------------------------------ | ---------- | ----- | --------------- |
| `web.vendor-shell` | Vendored trading shell `:8090` — 74 screens, 78 routes | `core-ops` | 2     | `wip`           |
| `ops.cms`          | Announcements, help centre, notices, whitepaper        | `core-ops` | 5     | `ready`         |
| `ops.site-config`  | Data dictionary, site information, app revision        | `core-ops` | 5     | `ready`         |
| `p2p.ctc`          | CTC fiat acceptor desk                                 | `p2p`      | 3     | `ready`         |
| `ops.campaigns`    | Activity / sign-in / bonus / red envelope              | `core-ops` | 5     | `socket` — §6.3 |
| `ops.promotions`   | Promotion cards, invite rewards                        | `core-ops` | 5     | `socket` — §6.3 |

`socket` rather than `ready` on the last two is deliberate: §13 says a socket is
"the interface exists; the impl does not", which is exactly true of a product
nobody has decided to want.

---

## 10 · Method, and what is not verified

Everything above was read or probed on 2026-08-02 against `main` @ `a43b469`,
from the worktree `docs/upstream-adoption-queue`:

- `find … -name '*Controller.java'` → 108; module breakdown counted, not quoted.
- `grep -rl "MemberWalletService\|MemberTransactionService\|MemberWalletDao\|MemberTransaction "
--include='*Controller.java'` → exactly 25 files, listed in §4.
- `node tooling/scripts/vendor-money-inventory.mjs` → 7 controllers, 14
  call-sites, 23 non-controller call-sites, 5 DAO definitions, 882 Java files.
- `find …/05_Web_Front/src -name '*.vue'` → 74; every file classified by grepping
  for `/api/` versus `/(uc|market|exchange|otc)/` and for `$http`/`fetch`/`axios`.
- `docker ps -a`, `docker logs intafaced-cx-{market,ucenter}`,
  `docker exec intafaced-cx-{mongo,redis}` for the live state and the two
  stack traces quoted verbatim in §2.
- `node tooling/ci/{vendor-java-money,vendor-shell,dual-book-door,custody}-scan.mjs`
  — all four clean; output quoted.
- `node tooling/ci/claim-check.mjs` for §9.4.
- `git ls-files` for the jar, mobile and robot counts.
- `gh pr list --state open` → #412, #411, #410, #346.
- **§7.3:** `services/svc-identity/src/db/schema.ts:23` (uuid),
  `…/core/…/entity/Member.java:27-29` (`Long`),
  `services/svc-ledger/src/db/schema.ts:32` (`owner_id` is `text`).
- **§8:** `git show c221cc8` and `git diff a19e337 HEAD -- vendor/upstream-exchange/01_wallet_rpc`;
  every `pom.xml` and `application.properties` under `01_wallet_rpc`;
  `grep -c rpc-common <module>/pom.xml` across all 14 modules for §8.3;
  `find -name RpcSecurityConfig.java` → one path; the key-generation and
  withdrawal call sites cited inline.

**Unverified, and named as such:**

- **§8 is a targeted read, not a security review, and must not be cited as one.**
  215 files were not read line by line. §8.3 was found by reading `pom.xml`s, not
  Java — which is precisely why §8.8 argues the deeper read will find more.
- **Whether ECT's committed secret at `ect/…/application.properties:14` is live
  or an upstream-mangled placeholder.** The value looks hand-altered. **Treat it
  as burned regardless** — the cost of being wrong is asymmetric and the
  remediation (rotate, move out of the tree) is the same either way.
- **The 3 committed jar artefacts were not decompiled or hash-verified** against
  any upstream release. Whether their bytecode matches the coordinates they claim
  is exactly what §8.6 item 5 exists to establish.
- **Whether the six unauthenticated modules would actually start** without
  `WALLET_RPC_AUTH_TOKEN`. The classpath analysis says the property is bound by
  nothing and the `@PostConstruct` guard cannot run; **that is a static argument
  and it has not been executed.** It is also not a reason to test it on a machine
  with a reachable port.

- **Whether the Java stack actually comes up after §2's fixes.** I did not apply
  them — this document changes no service, vendor or app source. The two stack
  traces prove the _causes_; they do not prove there is not a third failure
  waiting behind them. Expect one.
- **Whether the 45 non-money admin controllers are genuinely read-only.** I read
  their names, packages and the money-grep; I did not read all 45 bodies. The
  audit's bucket-3 entry ("read the 45 and confirm — a day of work, worth doing")
  is still open, and it is the honest precondition for starting `admin`.
- **The `04_Web_Admin` console — 92 `.vue` files.** Nobody has opened it. Its
  backend is bucket 1 + bucket 2; its front end is unread. I make no claim about
  it beyond the file count.
- **Whether `escrowLock`'s `assertPairedLocks` accepts the CTC shape.** The
  movement matches; I did not run it.
- **What `memberWalletService.transfer(order, ret)` (`otc-api/OrderController:643`)
  and `transferAdmin` (`AdminAppealController:300`) do internally.** I mapped them
  to `escrowRelease` from the surrounding flow, not from reading the service.
  Confirm before writing that adapter.

---

## Links

- Direction, settled: [`docs/DIRECTION-2026-07-31.md`](DIRECTION-2026-07-31.md) §4
- The ADR, Accepted: [`docs/adr/2026-07-28-vendored-exchange-integration.md`](adr/2026-07-28-vendored-exchange-integration.md)
- The evidence this queue rests on: [`docs/VENDORED-OVERLAP-AUDIT.md`](VENDORED-OVERLAP-AUDIT.md) (#213)
- The bucket-2 backlog, already written: `vendor/upstream-exchange/00_framework/core/…/interceptor/DualBookMoneyDoorInterceptor.java`
- Money inventory, regenerable: `node tooling/scripts/vendor-money-inventory.mjs` → [`docs/ORDER-ROUTE-VENDOR-MONEY-INVENTORY.md`](ORDER-ROUTE-VENDOR-MONEY-INVENTORY.md)
- Recipes: `packages/ledger-client/src/recipes/{index,bank,loans}.ts`
- Lane law: [`docs/SHEHZAD-HARD-OWNERSHIP-2026-08-01.md`](SHEHZAD-HARD-OWNERSHIP-2026-08-01.md) · [`docs/BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md`](BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md)
- Perimeter on the vendored ports: [`docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md`](A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md) — **§8.3 corrects lines 162-165 of it**
- The wallet-RPC hardening commit, and the best security writing in the repo: `git show c221cc8`
- Doctrine: §0.6, §4.2, §13 of [`INTAFACED_DEFINITIVE_BUILD.md`](../INTAFACED_DEFINITIVE_BUILD.md)
