# Split board — two streams, no collisions

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

> ## ⚠️ 29 July, owner offline 1–2h: **Nitro has full access to the whole app.**
>
> The territory rule below is **suspended** while Denon is away. Debug, wire and
> build anywhere — front end, services, Java, infrastructure. Everything below is
> now advice about where the sharp edges are, not permission you have to ask for.
>
> One thing still holds, because it is not about territory: **do not merge
> `feat/multi-asset-instruments`.** It changes the ledger's asset enum, and the
> owner merges money personally. Everything else is yours.

---

## WHERE THE APP ACTUALLY IS — read this before you open an editor

**We are building on top of the vendored exchange, and it lives in
`vendor/upstream-exchange/`.** That tree IS the product. It is not a reference copy,
not a sample to crib from, and not something to port screens out of.

| what                    | where                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| **the app you open**    | `vendor/upstream-exchange/05_Web_Front/` → http://localhost:8090              |
| the Java backend        | `vendor/upstream-exchange/00_framework/` (15 Maven modules)                   |
| the admin console       | `vendor/upstream-exchange/04_Web_Admin/`                                      |
| the wallet RPC          | `vendor/upstream-exchange/01_wallet_rpc/`                                     |
| our TypeScript platform | `services/`, `packages/` — reached from the app through `svc-edge` on `:4000` |

Provenance, so nobody wastes time wondering: the tree is a fork of the
open-source `CoinExchange_CryptoExchange_Java` project (Apache-2.0, attributed in
`vendor/upstream-exchange/NOTICE`). Upstream identifiers were `com.upstream.job-module`.
**That name is scrubbed from everything a user or the wider team sees, and
`brand-scan` enforces it** — but you will still meet it in Java package roots,
the MySQL schema name and the Mongo database name, because renaming those is a
live-data migration that has not happened yet (see §5 item 7).

`apps/web` (Next.js) is NOT the product. It is a small static shell that predates
the fork. Do not build features there.

---

## 1. The rule (suspended — see the banner)

**You may edit anything inside your own territory without asking. You may not
edit anything in the other stream's territory, ever — you open a request
instead.** One-line changes included. The cost of a two-minute wait is far
smaller than the cost of a conflicted `App.vue` at 2am.

|                   | **Stream A — Nitro**                                                                                                        | **Stream B — Denon**                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Owns**          | `vendor/*/05_Web_Front/src/pages/`<br>`vendor/*/05_Web_Front/src/components/`<br>`vendor/*/05_Web_Front/src/assets/images/` | `services/`<br>`packages/`<br>`tooling/`<br>`vendor/*/00_framework/` (Java)<br>`docker-compose*.yml`, `Dockerfile` |
| **Branch prefix** | `feat/app-*`                                                                                                                | `feat/spine-*`                                                                                                     |
| **Dev server**    | `:8090` (container `intafaced-shell-web`)                                                                                   | `:8091` (own container — see §3)                                                                                   |
| **Verifies with** | browser + `docker logs …` compile check                                                                                     | `pnpm verify` + `custody-scan`                                                                                     |

---

## 2. The shared spine — seven files, one owner each

These are the files two people always end up in at once. Every one of them
collided during today's agent run. Each now has exactly one owner.

| file                                        | owner                   | how the other stream changes it |
| ------------------------------------------- | ----------------------- | ------------------------------- |
| `05_Web_Front/src/App.vue`                  | **A**                   | B posts the nav item wanted     |
| `05_Web_Front/src/config/routes.js`         | **A**                   | B posts the route wanted        |
| `05_Web_Front/config/index.js` (dev proxy)  | **B**                   | A posts prefix → target         |
| `05_Web_Front/src/main.js`                  | **B**                   | A posts what's needed           |
| `05_Web_Front/src/assets/lang/en.js`        | **shared, append-only** | see below                       |
| `05_Web_Front/src/assets/css/intafaced.css` | **shared, append-only** | see below                       |
| `services/svc-edge/src/routes.ts`           | **B**                   | A posts prefix + port           |
| `docker-compose.apps.yml`                   | **B**                   | A never edits                   |

**Append-only convention** for the two shared files. Each stream writes only
inside its own marked region, so git merges them cleanly instead of conflicting:

```
/* ── stream A ─────────────────────────────────────────────── */
   …Nitro's additions…
/* ── stream B ─────────────────────────────────────────────── */
   …Denon's additions…
```

Never reorder, reformat or prettier-sweep the whole file. That turns a clean
merge into a 400-line conflict.

---

## 3. Infrastructure — the actual speed unlock

Today's real bottleneck was not merge conflicts. It was **one dev server**.
Hot reload does not work over the Windows bind mount (`poll: false` in
`config/index.js`), so every edit needs `docker restart` — and a restart by one
person blows away the other person's in-progress state for ~90 seconds.

**Fix it first, before any feature work. Two independent servers:**

```bash
# Stream A keeps :8090 as-is.

# Stream B gets its own worktree and its own container:
pnpm wt feat/spine-work
docker run -d --name intafaced-shell-b \
  -v "C:/Users/User/plug-x-inta-worktrees/feat-spine-work/vendor/upstream-exchange/05_Web_Front:/app" \
  -v "C:/Users/User/plug-x-inta-worktrees/feat-upstream-exchange-integration/vendor/upstream-exchange/05_Web_Front/node_modules:/app/node_modules" \
  -w /app -p 127.0.0.1:8091:8080 -e HOST=0.0.0.0 node:16 sh -c "npm run dev"
```

`node_modules` is bind-mounted from the same place for both — it is read-only in
practice and installing twice wastes fifteen minutes.

**Also set `poll: 1000`** in `config/index.js` (owner: B). It makes the watcher
actually fire on Windows and removes the restart cycle entirely. This is the
single highest-leverage change on this page.

**Do not both run `pnpm db:migrate` against `intafaced` on :5433.** Stream B
owns that database. Stream A uses the Java MySQL on :5506, which B does not
touch.

---

## 4. Stream A — Nitro (app surface)

Ordered. Top of the list is the highest visible value.

1. **Look at the terminal in a browser.** Nothing this session was visually
   verified — all checks were compile- and endpoint-level. The layout, the
   chart skin and the depth graph have never been seen by a human. Expect to
   find things.
2. **Every price is `0`.** The pairs are seeded and `/market/symbol-thumb`
   answers, but nothing has ever matched, so the chart has a working datafeed
   and no bars. Either seed candle history into the Java `market` service or
   point the datafeed at an external venue for history. **This is the difference
   between a demo that lands and one that doesn't.**
3. **Zero-KYC DEX path in the shell.** The plane switch already exists and is
   correct in the services (`checkAccess` short-circuits protocol +
   non-custodial to `allowed.permissionless` _after_ region screening). What's
   missing is the UI: a DEX/CEX toggle that actually selects the plane, with the
   member/KYC gates stripped on the protocol side and kept on the CEX side.
4. Order-entry polish: validation, precision, fee preview, confirmation states.
5. Wire the account panes — Balances / Positions / Open Orders / History — to
   real endpoints and prove each one with data.
6. Mobile. The shell has a drawer; nobody has checked it since the retheme.
7. Empty and error states across every screen. The backend will be down
   sometimes; it must never blank-screen.

**Blocked on B — post the request and move on:** any new `/api/*` proxy prefix,
any new edge route, anything in `main.js`.

---

## 5. Stream B — Denon (spine)

1. **Redeploy the fleet** with the three fixes already committed but not yet
   running: `svc-protocol`'s router mount, `svc-token`'s tier, `svc-indexer`'s
   edge route + the `4012→4013` port correction. Until this ships, the protocol
   and chain screens 404 no matter what Stream A does.
2. **Scope issuance for `bank` and `blueprint`.** `AuthService.defaultScopes()`
   issues neither `bank:read` nor `blueprint:read` **to anybody**, so no user in
   the platform can open a bank space. Decide what gets issued to whom — this is
   a policy call, not a patch. Two screens are dark until it's made.
3. **P2P offers are 403 for a different reason** — the scope _is_ held; the
   jurisdiction matrix wants verification tier `basic`. Decide whether that's
   correct and make the UI say which of the two refusals it hit.
4. **`svc-trade` never checks trading hours.** `isInstrumentOpen` exists and is
   tested but the order-create path doesn't call it, so a weekend EUR/USD order
   is accepted today. Ships with the multi-asset branch.
5. **Close the `workspace-sync` gap.** Check 5 catches a wrong upstream port —
   but only in the edge's own environment block. `svc-dex` called the indexer on
   the wrong port and the gate stayed green. Widen it to every service-to-service
   `*_URL`.
6. ~~**Decide `svc-matching` and `svc-ws`.**~~ **Resolved — both are correct.**
   Neither exposes a tRPC router because neither should. `svc-matching` serves
   plain HTTP behind `verifyServiceHeaders` with `INTERNAL_SERVICE_SECRET` —
   service-to-service only, and it answers 401 rather than 403 to a caller that
   has not said who it is. `svc-ws` serves websockets, which the edge cannot
   proxy because it buffers, so the browser reaches it directly; its snapshot
   carries no cookie, no token and no per-caller content. Not the
   unmounted-router bug. Written down here so it does not get re-raised.
7. **The Java rebrand — 666 files.** Investigated 29 July; **not started, on
   purpose.** The Java build baseline is green (14 modules, `BUILD SUCCESS`,
   Maven 3.8.6 / JDK 1.8.0_342), so the blocker is not the build. It is this:

   **MongoDB is the real hazard, not Hibernate.** Spring Data stamps a `_class`
   discriminator into every document. The live `job-module` database holds **1,420
   documents across 60 collections, every one carrying
   `_class: "com.<vendor>.job-module.entity.KLine"`.** Rename the package and every
   historical K-line becomes unmappable — including the ones feeding
   `symbol-thumb`, i.e. the chart. The rename must ship in lockstep with a
   `_class` migration, and the vendor tree has no migration framework to carry
   that to another environment.

   **The vendor names are also live datastore names.** The MySQL schema is
   `upstream` (8 JDBC URLs plus compose `MYSQL_DATABASE`) and the Mongo database is
   `job-module`. A blanket replace points every app at a schema that does not exist,
   and `ddl-auto=update` then cheerfully builds 64 empty tables next to the real
   ones. So this cannot be a single-pattern sweep — those strings must be
   excluded explicitly.

   **Do NOT pin `@Table` annotations first.** That was in an earlier version of
   this item and it was wrong. JPA implicit naming derives from the _entity
   name_, never the package: all 27 entities lacking `@Table` were verified to
   map to exact snake_case renderings of their class names, across all 64 live
   tables, zero exceptions. Renaming packages without renaming classes cannot
   change a table or column name. Hand-adding 27 annotations would be 27 chances
   to typo a table name into precisely the catastrophe the pinning was meant to
   prevent.

   **Sequence — custody first, rename second.** The rename rewrites the `package`
   line and every import in 666 files, so it conflicts with everything. It is
   also script-regenerable in minutes, and custody work is not. Landing the
   rename first maximises the other stream's pain for no gain.

   Then: exclude the datastore names, rename only the package coords, the
   groupId, the `*-parent` / `*-job` artifactIds and the one vendor-named module
   directory. No `@ComponentScan` / `@EntityScan` / `@EnableJpaRepositories`
   declares an explicit base package, so a consistent move needs no annotation
   edits at all.

   The `vendor/` directory rename has a surprisingly small blast radius outside
   the vendor tree — four lines, and neither the root compose files nor the
   `Dockerfile` reference it. Only after **both** the directory and the package
   root are renamed may the two brand-scan allowlist entries be deleted; each
   names that condition itself.

   Also found in passing: the coinex Redis password in config does not match the
   running container, and the vendor root `pom.xml` description plus
   `sql/db_patch.sql` still carry Chinese text. Both belong in this pass.

8. **Java custody hardening** — unauthenticated withdrawal `GET`s, empty-string
   ETH keystore passwords, and a hardcoded `987654321asdf` trading backdoor.
   These are line items in the fork, not blockers, but they must not reach
   production.
9. `svc-academy` and `svc-launch` do not exist. Two screens say so honestly.

---

## 6. Owner-only — nobody else can do these

- **Merge the money branches.** `feat/multi-asset-instruments` touches the
  ledger's asset enum. Standing rule: _auto-open a PR, never auto-merge._
- **The sanctions blocklist is empty.** Screening works and screens nothing.
  This needs counsel before a public DEX. It is a compliance decision, not an
  engineering one, and it is the one item that can stop a launch.
- **Visual sign-off** on the rebrand.

---

## 7. Merge protocol

- **Rebase, never merge, onto `main`.** Two long-lived branches plus merge
  commits will produce exactly the conflict this document exists to prevent.
- **Push at least once a day, even mid-task.** A three-day branch in this repo
  is a guaranteed conflict.
- **`pnpm verify` before every push** (Stream B). Report what it actually
  printed, including failures. The DoD gate reports failure on four manual
  sign-off items that are not automatable — that is expected and is not a
  regression.
- **Ordering:** land `feat/rebrand-english-black-orange` first. Everything else
  is built on it, and it is already green.

---

## 8. Requesting a change in the other stream's territory

Open an issue titled `[cross-stream] <file> — <what>`, with the exact diff you
want. Owner applies it in their next push. Do not "just quickly" edit it — that
is precisely how today's proxy-prefix collision happened, where `/exchange` was
registered as an API prefix while also being the SPA route, and a hard refresh
on the trading page started returning the exchange service instead of the app.
