# Build coverage audit — the law, the later decisions, and the tracker

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Question asked:** _"Are we building every feature from the definitive build, plus the changes we layered on top of it?"_

**Type:** audit. **No code was changed.** Read-only against `main` @ `99a7673` (#429), `tooling/tracker/features.mjs` (127 rows), `INTAFACED_DEFINITIVE_BUILD.md` v2.2 (862 lines), 4 ADRs, 5 `SPEC-*` docs.
**Decision owner:** repo owner. **Nothing here is a decision.** Where a §-number and an ADR disagree, this document reports the disagreement and does not resolve it.

---

## The answer, up front

**No — and the mechanism that was supposed to tell you that was never built.**

§25 line 740 of the law says, verbatim:

> _CI carries `coverage-check`: this matrix is machine-readable (`tooling/coverage.yaml`); any Vol. I feature without a green DoD at its phase gate blocks the drop phase that promised it. **Never half done — enforced.**_

`tooling/coverage.yaml` **does not exist.** No `coverage-check` job exists in `.github/workflows/ci.yml`. The law specified a machine to answer exactly the question you just asked, and that machine is one of the things that was never built — which is why this audit had to be done by hand, and why the gap it found is the size it is.

### Headline numbers

|                                                                   | count                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Law-specified capabilities with **no tracker row at all**         | **40**                                                                                               |
| — of which are the whole of v2.1 + v2.2 (§27–§37)                 | **20** (100% of the law written after v2.0)                                                          |
| Tracker rows with **no basis in the law as written**              | **18** (1 orphan · 1 contradiction · 13 §13-extensions · 3 decided evolutions)                       |
| Is the sovereign / no-KYC layer tracked?                          | **No.** Built in code, absent from the board, and the tracker's default **inverts** the routing rule |
| Places the law and an accepted ADR/spec **contradict each other** | **10**                                                                                               |
| Services running on disk with **no tracker row**                  | **2** (`svc-edge`, `svc-dex`) + the vendored shell + `04_Web_Admin`                                  |
| Decision-blocked items (the expensive kind)                       | **7**, gating ~24 rows                                                                               |

---

# A · THE LAW → THE TRACKER

## A1 · Specified in the law, **no tracker row at all** — 40

These are the ones that get silently forgotten. A prior audit found five (vendored, §B3); the full sweep finds forty.

### A1.a — v1.0 / v1.1 / v2.0 (§1–§26) · 20 hard gaps

| #   | Capability                                                                                          | Law                                          | Nearest tracker row                                            | Notes                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | **No-KYC lane as a first-class capability**                                                         | `INTAFACED_DEFINITIVE_BUILD.md:642`, §22:584 | none                                                           | Built in code, unrepresented. See §B1 — this is the headline                                             |
| 2   | Native mobile apps (iOS/Android, own name)                                                          | `:635`, `:727`                               | none                                                           | §25 phases it 2–5. Zero rows, zero code                                                                  |
| 3   | Custody ops — cold/warm/hot, multi-sig approvals                                                    | §9 `:433`, §25 `:722`                        | none                                                           | §25 phases it **2**. A three-layer custody runbook with an admin approval workflow has no board presence |
| 4   | Portfolio suite (users + house)                                                                     | `:723`                                       | none                                                           |                                                                                                          |
| 5   | Site builder                                                                                        | `:724`                                       | none                                                           |                                                                                                          |
| 6   | Social promotion / share pipeline                                                                   | `:725`                                       | `blueprint.card` (card only)                                   | The acquisition artefact's distribution half                                                             |
| 7   | CRM / HR & team / Finance / Project engine                                                          | `:714`                                       | `ops.support` (tickets+KB only)                                | Four named systems, one adjacent row                                                                     |
| 8   | Marketing engine (+ Growth Agent)                                                                   | `:719`                                       | none                                                           |                                                                                                          |
| 9   | Knowledge base / workflow automation                                                                | `:720`                                       | none                                                           |                                                                                                          |
| 10  | Video library                                                                                       | `:707`                                       | none                                                           |                                                                                                          |
| 11  | AI Coach                                                                                            | `:708`, §8.2 `:388`                          | none                                                           |                                                                                                          |
| 12  | **Agents ×5** — Portfolio, Launch, Risk&Compliance, Coach, Growth                                   | §8.2 `:388`, `:732`                          | 6 agent rows exist                                             | Law names **10 agents**; tracker carries 5 + gateway                                                     |
| 13  | Fundraising module (milestones, investor mgmt)                                                      | `:658`                                       | none                                                           |                                                                                                          |
| 14  | Structured issuance (wrapped/synthetic)                                                             | `:661`                                       | none                                                           | §13-flagged in the law, no socket row                                                                    |
| 15  | Drop-phase flags — waitlist + referral queue, founding-badge NFT mint, season engine, limited drops | §11 `:447-455`                               | none                                                           | "The drop sequence is configuration" — the configuration does not exist                                  |
| 16  | PII isolation — KYC docs in a separate encrypted store                                              | §10 `:443`                                   | none                                                           | Compliance-load-bearing                                                                                  |
| 17  | Per-module SLO dashboards                                                                           | §9 `:435`, §14.5 `:483`                      | `infra.compose` (OTel/Grafana only)                            | §14.5 is a **DoD condition**; no module can honestly pass it                                             |
| 18  | Privacy stack — stealth handles, client-side vault analytics, no-resale law                         | §26 `:742-746`                               | `blueprint.attestations` (zero-PII half only)                  |                                                                                                          |
| 19  | **`tooling/coverage.yaml` + CI `coverage-check`**                                                   | §25 `:740`                                   | none                                                           | Verified absent. The law's own coverage enforcement                                                      |
| 20  | Public API gateway as **one** surface                                                               | §9 `:430`                                    | `pay.public-api` (pay-scoped), `trade.ccxt-api` (trade-scoped) | "One gateway in front of trade/pay/data" is three rows and no owner                                      |

### A1.b — v2.1 THE EXECUTION EMPIRE (§27–§30) · 10 hard gaps · **0% tracked**

| #   | Capability                                                                | Law            | Notes                                                                                                             |
| --- | ------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| 21  | Venue Vault — per-user encrypted external API keys, HSM, trade-only scope | §27 `:761`     | `venue.aggregation`'s own note admits "Venue Vault absent" (`features.mjs:318`)                                   |
| 22  | Unified data lake — normalised ticks/books/fills, the backtest fuel       | §27 `:762`     |                                                                                                                   |
| 23  | Latency grading feeding live routing weights                              | §27 `:760`     |                                                                                                                   |
| 24  | `svc-execution` — cross-venue Smart Order Router / OMS-EMS                | §28 `:770`     | `services/svc-dex/src/quote/market-data-source.ts:190` refuses **by name** because "svc-execution does not exist" |
| 25  | Arbitrage engine (cross-exchange, triangular, basis, funding)             | §28 `:772`     |                                                                                                                   |
| 26  | Market-making engine as **external-venue** MM                             | §28 `:773`     | `trade.mm-bot` covers internal seeding only                                                                       |
| 27  | House desk sealed private tenant — the Throne Law                         | §28 `:777`     | A tenancy isolation requirement with no row and no test                                                           |
| 28  | `svc-quant` Strategy Studio + Code SDK + sandboxed runtime                | §29 `:783-787` | Sandbox-escape suite is a §30 DoD addition                                                                        |
| 29  | Backtest engine + walk-forward / Monte Carlo + honesty enforcement        | §29 `:785`     |                                                                                                                   |
| 30  | Strategy marketplace + compute tiers                                      | §29 `:788-789` |                                                                                                                   |

§30 `:793` puts Connect **and** Execution in **Phase 2** — the phase currently being worked. They are not on the board at all.

### A1.c — v2.2 GAP CLOSURES & FORCE MULTIPLIERS (§31–§37) · 10 hard gaps · **0% tracked**

| #   | Capability                                                         | Law            | Notes                                                                                              |
| --- | ------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------- |
| 31  | Auto-invest — DCA, card round-ups, threshold sweeps                | §31 `:805`     |                                                                                                    |
| 32  | Tax engine (`svc-tax`, owned not vendored)                         | §31 `:807`     |                                                                                                    |
| 33  | **Alerts & watchlists**                                            | §31 `:809`     | Law phases the **alerts core at Phase 2**. Zero rows; `ops.notifications` is fan-out, not alerting |
| 34  | Business banking + **crypto payroll** (`svc-bank-biz`)             | §31 `:811`     |                                                                                                    |
| 35  | **INTAFACED PREDICT — module XII, the twelfth room**               | §32 `:813-821` | An entire named module of the product, absent from the board                                       |
| 36  | Crew vaults — multi-sig crew treasuries                            | §33 `:823-825` |                                                                                                    |
| 37  | Legacy vaults — time-locked inheritance, guardian M-of-N           | §34 `:827-829` | And see §B5.2 — the tracker actively refuses the guardian primitive                                |
| 38  | Launch trust layer — LP locks, vesting proofs, deployer reputation | §35 `:831-837` |                                                                                                    |
| 39  | Treasury yield on stables (RWA T-bill vaults)                      | §36 `:839-841` |                                                                                                    |
| 40  | INTAFACED INFRA — ramp widget + white-label B2B                    | §37 `:843-848` | Law calls it "potentially the largest single revenue line in the stack"                            |

§38 `:853` states the module count moved **11 → 12** and products **24 → 28**. The tracker does not know the twelfth room exists.

### A1.d — soft gaps: named in the law, folded into a coarser row, never named again

Not counted above. They are not forgotten, but nobody can tell from the board whether they are built:

| Law capability                                                                                                             | Swallowed by                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Sub-accounts + consolidated reporting (`:634`, Phase 1)                                                                    | `identity.apikeys` title — and `SPEC-SUBACCOUNTS-2026-08-02.md` treats it as its own M5 product       |
| Referrals, token-paid (`:718`)                                                                                             | adjacent to `ops.affiliates`                                                                          |
| Specialist rooms taxonomy (`:700`), clip export (`:702`)                                                                   | `academy.lobbies` (whose note says curriculum/certs/ambassador pay are "deliberately not built here") |
| Instant listing (`:657`)                                                                                                   | adjacent to `launch.token-factory`                                                                    |
| Checkout builder (`:684`), merchant onboarding (`:680`), revenue analytics + export (`:687`), high-risk verticals (`:686`) | `pay.gateway` / `pay.psp`                                                                             |
| Cashback in IFC (`:669`)                                                                                                   | `bank.cards`                                                                                          |
| Gas as `feeCharge(reason:'gas')` (§4.3 `:205`), full distribution table (`:730`)                                           | `token.*`                                                                                             |

## A2 · Specified, tracked — and where the score and the code disagree

The tracker is broadly honest; its notes are unusually good. Four rows are not.

| Row                 | `features.mjs` | Tracker says                                                                           | Code says                                                                                                                                                                                                                                             | Direction of error                                                                 |
| ------------------- | -------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `bank.loans`        | `:599-606`     | **`done`**, note lists residuals as "bank.earn / bank.cards / go-live policy"          | `services/svc-bank/src/loans/prices.ts:12-30`: §8.1's "marks from svc-trade index prices" describes **a component that has not been built**; loans mark off **last trade**, and the file spells out the manipulation attack in both directions        | **Over-scored.** The mark problem is not mentioned in the row at all               |
| `chain.mainnet`     | `:576-581`     | ⛔ blocked **on `protocol.amm`**                                                       | No `services/svc-chain`, zero Go files, no genesis/app.toml/config.toml, no CometBFT/Cosmos dependency anywhere. `packages/config/src/flags.ts:120` is a null-default flag; `services/svc-dex/src/quote/indexer-venue.ts:82` is a venue-id **string** | **Wrong blocker.** Closing `protocol.amm` would not unblock it by one day. See §B4 |
| `venue.aggregation` | `:312`         | Title: "External venue adapters **via CCXT**"                                          | §27 `:755` forbids a third-party connectivity library in the money path; the row's own note says "NOT 'via CCXT' … there is no `ccxt` in the workspace by design"                                                                                     | **Title contradicts the law it implements.** Note is right, title is not           |
| `trade.copy`        | `:277-284`     | Title: "…audited leaders, **profit share**"; `plane: 'B'`; `dependsOn: ['trade.spot']` | `SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md:95` forbids any P&L-linked fee; `:24` routes copy execution to **Protocol**; `:158` makes session-key scope the first thing that ships                                                                 | **Three errors in one row.** See §B2                                               |

Rows whose notes are conspicuously honest and should be read as the standard: `infra.i18n` (`:123`), `ops.admin` (`:786`), `blueprint.ownership` (`:566`), `blueprint.card` (`:551`), `socket.clob-contracts` (`:936`), `pay.rails` (`:387`), `trade.forex` (`:289`).

## A3 · In the tracker, **not in the law** — 18

| Class                                               | Rows                                                                                                                                                                                                                                                                                                                                | Verdict                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orphan — nobody decided it**                      | `trade.ccxt-api` (`:298`)                                                                                                                                                                                                                                                                                                           | No law basis, **no ADR, no spec.** `grep -l CCXT docs/adr/ docs/SPEC-*.md` → empty. Acknowledged in passing as an existing fact at `docs/DIRECTION-2026-07-31.md:21` ("Spot is real today — matching, holds, venue hours, CCXT contract"), never decided as product. It is now the de-facto public trade API and it has no owner and no spec                                                 |
| **Contradicts the law**                             | `socket.social-recovery` (`:908-915`)                                                                                                                                                                                                                                                                                               | Tracker: "Deliberately absent: a guardian is a second party who can take the account, and the platform must never be one." Law §17.4 `:525` lists **social recovery** as a property of the smart account; §34 `:829` specs **guardian sets (M-of-N)** as a premium product; §38 `:854` adds a guardian-recovery DoD test. **A tracker row overrode two law sections with no ADR.** See §B5.2 |
| **§13 extensions the law never absorbed** — 13 rows | `socket.contract-toolchain`, `socket.contract-audit`, `socket.userop-differential-test`, `socket.p256-verifier`, `socket.ledger-sharding`, `socket.evm-rpc`, `socket.clob-contracts`, `socket.indexer-stream`, `socket.stream-provider`, `socket.notify-push`, `socket.notify-email`, `socket.notify-sms`, `socket.social-recovery` | §13 `:469-476` lists **five** sockets. The tracker carries **19**. §14.8 requires "zero TODOs referencing 'later' **without a §13 socket entry**" — that condition is checked against a list which does not contain fourteen of them. Legitimate evolution, unamended law                                                                                                                    |
| **Deliberate evolution with a written decision**    | `identity.kyc-review` (`docs/decisions/kyc-posture.md`), `identity.step-up` (§9-adjacent, note explains the bug it closed), `infra.worktrees` (`CONTRIBUTING.md`)                                                                                                                                                                   | Fine                                                                                                                                                                                                                                                                                                                                                                                         |

Rows that look extra-legal but are not: `ws.depth` (§5.3 stream decomposition), `web.shell` (§2), `pay.user-money` (§4.2 recipes), `trade.mm-bot` (§5.2), `matching.determinism` (§5.1).

## A4 · Running code with **no tracker row and no law row**

| On disk                                 | State                                                                                                                                                                             | Row?     | Law?                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `services/svc-edge`                     | The **only** service a browser talks to (`docker-compose.apps.yml:130`, `:189`); signs `x-intafaced-principal` for every routed request; every other service's auth depends on it | **none** | **not in §2's layout** (`:47-84`)                                                                                                |
| `services/svc-dex`                      | 29 TS files, deployed at `docker-compose.apps.yml:152`, quote + route + permissionless procedures                                                                                 | **none** | §8.6 specs it; §17.5 `:539` says it "is absorbed into this plane". The law contradicts itself and the row fell through the crack |
| `vendor/upstream-exchange/05_Web_Front` | The **deployed** trading shell, `:8090` (`docker-compose.apps.yml:718-728`), 71 `.vue` files, the target of 7 of the last 12 merges                                               | **none** | —                                                                                                                                |
| `vendor/upstream-exchange/04_Web_Admin` | 92 `.vue` staff console, has a real `build` script, in **neither** compose file, **no `# no-deploy:` reason**                                                                     | **none** | —                                                                                                                                |

---

# B · THE LATER DECISIONS → THE TRACKER AND THE LAW

## B1 · The sovereign routing rule — built in code, **absent from the tracker, and inverted by its default**

**Is it tracked?** No.

- There is **no row** for permissionless / no-KYC access. §25 `:642` lists "No-KYC lane | P | entire plane, by architecture | 3P" as a capability with an owner and a phase. No tracker row exists for it.
- The only mention of §22 anywhere in 960 lines of tracker is one clause inside `identity.kyc-review`'s note (`features.mjs:172`): _"§22 permissionless surfaces read no tier"_. That is the entire board presence of the platform's differentiating claim.
- It is **implicit in the `plane` field only** — `'F' | 'P' | 'B'` per row.

**The code is well ahead of the board.** Verified:

| Thing                                      | Where                                                                                     | State                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `checkAccess` permissionless short-circuit | `packages/config/src/jurisdiction.ts:363`                                                 | Real: `q.plane === 'protocol' && !mod.custodial`                                                                                          |
| Region screening runs **before** it        | `packages/config/src/jurisdiction.ts:365-374`                                             | Correct, and the ordering is documented as load-bearing at `:358-362`. Matches `SPEC-SOVEREIGN…:140`                                      |
| Custodial registry                         | `packages/config/src/modules.ts:64-109`                                                   | `dex`, `chain`, `indexer`, `protocol` = `custodial:false`; `bridge` deliberately `true`                                                   |
| Enforcement                                | `packages/contracts/src/trpc.ts:114-175`                                                  | One middleware, not re-implemented per service. 20 procedures in `svc-protocol`, 7 in `svc-indexer`, 2 in `svc-dex`                       |
| User-visible lane                          | `apps/web/src/components/terminal/plane-switch.tsx:31-50`; `apps/web/src/lib/plane.ts:59` | "A wallet. No sign-in, no verification, no account." Protocol panels use a **token-free** client (`apps/web/src/lib/providers.tsx:53-62`) |

**The one thing that is actively wrong.** `tooling/tracker/features.mjs:60`:

```js
plane: opts.plane ?? 'F',
```

**The tracker's default plane is Fiat.** `SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md:17` says the opposite: _"A feature goes on the Fiat Plane only if it must hold user value or must know who the user is."_ Every new row added without an explicit `plane:` silently lands custodial. The routing rule is not merely untracked — the registry's default contradicts it, and does so invisibly.

**Residual honesty risk, not a code bug:** the permissionless lane's screening is only as real as `INTAFACED_SANCTIONS_REGIONS`, which ships **empty** (`packages/config/src/screening.ts:25-32`), and no `JURISDICTION_MATRIX` entry carries `blocked:true` (`packages/config/src/jurisdiction.ts:144-167`, self-labelled "Illustrative structure only — populate per counsel"). Prod/staging refuse to boot without it (`:516-534`), which is right. The list itself is `DIRECTION-2026-07-31.md` §8.7 — counsel, not engineering.

## B2 · Copy trading — **the tracker still says the old thing**

`tooling/tracker/features.mjs:277-284`:

```js
f('trade.copy', 'Copy trading, audited leaders, profit share', {
  module: 'trade', phase: '2', plane: 'B', owner: 'shehzad002',
  dependsOn: ['trade.spot'],
  note: 'HUMAN M4 @shehzad002. Agents must not invent copy product.',
}),
```

| What the row says           | What the accepted spec says                                                                                                                         | Cite                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| "**profit share**"          | _"**Not permitted in v1:** any fee computed from follower P&L, in any form — percentage of gains, high-water mark, hurdle rate, or 'success fee'."_ | `SPEC-SOVEREIGN…:95`  |
| `plane: 'B'`                | copy execution → **Protocol**, "user's own account signs; we never hold"                                                                            | `SPEC-SOVEREIGN…:24`  |
| `dependsOn: ['trade.spot']` | _"Session-key scope + on-chain caps in `SmartAccount` — **the whole safety model is here; nothing else ships first**"_                              | `SPEC-SOVEREIGN…:158` |
| note: no spec reference     | `DIRECTION-2026-07-31.md:80` marks copy **SUPERSEDED 2026-08-01** and names the spec                                                                |                       |

The law is stale in the same two places: §5.2 `:256` ("profit-share settled monthly by ledger recipe") and §25 `:629` ("Copy trading (audited leaders, profit share) | **B**").

**Consequence, concretely:** the row is owned by a human (M4), phased at 2, and depends on a `done` row — so it renders in `docs/TRACKER.md` under **"🟢 Claim these now"** as _"Copy trading, audited leaders, profit share"_. Anyone reading only the board builds a performance-fee product against a spot exchange. That is the exact shape three separate documents forbid. A wrong row is worse than a missing one.

`agents.copy-intel` (`:656`) is consistent with §5.2 but pre-dates §4 of the spec ("no leaderboard ranked by returns") — "audited stats" remains permitted; ranking does not. Worth a note, not a rescore.

## B3 · The vendored product — adopted by ADR, **invisible on the board**

`docs/adr/2026-08-02-adopt-vendored-product-keep-our-ledger.md` is **Accepted**. It says (`:46`):

> _"**Stop rebuilding these.** Five have no tracker row, and that absence is the mechanism by which they keep getting rebuilt — so **the rows get created as part of adoption.**"_

**The rows were not created.** `grep -i vendor tooling/tracker/features.mjs` → zero rows. One day after the ADR, the adoption obligation it wrote for itself is unmet.

| ADR obligation                                                                                                                   | Tracker state                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADOPT AS-IS: shell + screens, OTC + admin workflows, CMS, support, statistics + finance reporting, admin RBAC                    | **0 rows**                                                                                                                                                                                    |
| The five with no row (`VENDORED-OVERLAP-AUDIT.md:332`): CMS, red envelope, activity/sign-in, support chat content, mining orders | **still 0 rows**                                                                                                                                                                              |
| ADOPT AND ADAPT: every controller reaching `MemberWalletService` — keep the workflow, redirect the balance write                 | **0 rows.** `ORDER-ROUTE-VENDOR-MONEY-INVENTORY.md:64-69` counts 7 controllers, 14 controller call-sites, 23 non-controller call-sites, 5 DAO defs — a real work queue with no board presence |
| `01_wallet_rpc` — adopted, security review a **precondition**                                                                    | **0 rows.** 14 controllers handling BTC/ETH/USDT/EOS private keys, on a classpath with 31 unverifiable `.jar` binaries                                                                        |

**And the tracker scores the wrong front end.** `apps/web` is scored twice — `web.shell` **`done`** (`:329`), `web.terminal` **`wip`/Nitro** (`:320`). The vendored shell is the one deployed at `:8090` and the one taking the work: `#412 #414 #417 #418 #419 #421 #426` are all `feat(vendor)`/`fix(vendor)`. `web.terminal`'s own note admits it (`features.mjs:327`): _"sub-accounts selector #358, a11y #367 **on vendor shell**"_. A row named `apps/web` is being progressed by commits to `vendor/`.

**Two enforcement gaps, one closed and one not:**

- ✅ The four dual-book mutators **are** now scanned in Java — `tooling/ci/vendor-java-money-scan.mjs:83` walks `.java`, roots at `vendor/`, fails closed if `vendor/` is missing, and is in CI (`.github/workflows/ci.yml:44`). The ADR's and `DIRECTION` §4's complaint on this specific point is satisfied.
- ❌ **`custody-scan` still walks `.ts`/`.tsx` (`tooling/ci/custody-scan.mjs:80`) and `.sol` (`:101`) only.** Doctrine 10 — "the custody boundary is drawn in code" — is structurally blind to 949 Java files. This is finding F1 of `VENDORED-OVERLAP-AUDIT.md:326`, restated by the ADR as "closes alongside, not after", and it is **still open**.
- ❌ **`workspace-sync` check 7 covers nothing in `vendor/`.** `tooling/ci/workspace-sync.mjs:445-447` discovers vendored front-ends via `workspacesUnder('vendor')`, which only returns directories carrying their own `package.json` — and `vendor/upstream-exchange/package.json` does not exist, so the array is empty. Verified by running the scan: `workspace-sync clean — 17 service(s)`. `04_Web_Admin` has a `build` script, appears in neither compose file, and carries no `# no-deploy:` reason — **the gate written for exactly this failure passes.** The comment at `:442-444` claims vendored front-ends are "DISCOVERED, not named"; they are not discovered.

## B4 · INTACHAIN — what `chain.mainnet` is actually blocked on

**The row, in full** (`tooling/tracker/features.mjs:576-581`):

```js
f('chain.mainnet', 'INTACHAIN — CometBFT + native CLOB module', {
  module: 'chain', phase: '4P', plane: 'P',
  dependsOn: ['matching.engine', 'protocol.amm'],
}),
```

No `status`. No `note`. No `owner`. `docs/TRACKER.md:202` therefore renders **⛔ blocked · `protocol.amm`**.

**That is not what it is blocked on.** Verified:

- `services/svc-chain` — **does not exist.** Named only as an aspiration at `INTAFACED_DEFINITIVE_BUILD.md:532`.
- `services/svc-bridge` — **does not exist.** `tooling/ci/custody-scan.mjs:30` excludes it from the Protocol-Plane list; it excludes a service that was never written.
- Repo-wide `INTACHAIN|CometBFT|cosmos-sdk|tendermint` returns **prose, one null-default flag, and one string**: `packages/config/src/flags.ts:120` (`def('chain.mainnet', 'chain', null, …)`) and `services/svc-dex/src/quote/indexer-venue.ts:82` (`id = 'intachain-clob'`, which `services/svc-dex/README.md:100` says **refuses** with `not_ready`).
- Zero `.go` files. No `genesis.json`, no `app.toml`, no `config.toml`. The only chain code in the repo is **EVM**, not Cosmos.

**The real blockers, in order, and none of them is the AMM:**

1. **The §17.2 sequencing decision was never taken.** The law offers P0 (contracts on an established EVM L2, "ship value in weeks") → P1 (own CometBFT chain). Nothing on record chooses between them, and the repo has drifted into P0's _shape_ (EVM, viem, anvil) without ever adopting P0's _plan_. **Decision-blocked.**
2. **No production chain, no signing-key custody, no deployment record.** `docs/decisions/local-dev-chain.md:75-90` states this explicitly and titles itself _"A local dev chain is not a chain decision"_. `DIRECTION-2026-07-31.md` §8.3 reserves prod RPC + signing-key custody to the owner. **Decision-blocked.**
3. No validator plan, no CometBFT version, no owner named anywhere. **Unverified** that anyone has scoped it.
4. The **only** written blocker statement in the entire docs tree is one line: `docs/audit/2026-07-30-overnight-wave/WAVE-AUDIT-RESULT.md:39` — _"chain.mainnet — provider decision; smart-accounts 27 unlocks need real RPC."_

**Is the blocker recorded honestly?** **No.** The tracker says a dependency; the truth is a decision. Five rows sit behind it — `chain.evm`, `chain.validators`, `chain.governance`, `chain.rust-core`, `bridge.canonical` — and `bridge.canonical` is the only thing that would make §17.3's "one supply, two planes" true. An empty `note:` field is why nobody knows this, and it costs thirty seconds to fix.

## B5 · Where the law and the later decisions contradict each other — 10

**Do not edit the law from this document.** Each of these needs the owner's pen or an ADR.

| #   | Law says                                                                                                                                  | Later decision says                                                                                                                                                                       | Cite                                          | Severity                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §5.2 `:256`, §25 `:629` — copy trading pays **profit share**, plane **B**                                                                 | Any P&L-linked fee is **not permitted in v1**; copy execution is **Protocol**                                                                                                             | `SPEC-SOVEREIGN…:95`, `:24`; `DIRECTION…:80`  | **High** — the law currently describes an unlicensed-manager structure                                                                 |
| 2   | §17.4 `:525` **social recovery** is a smart-account property; §34 `:829` guardian M-of-N is a **product**; §38 `:854` a guardian DoD test | `features.mjs:908-915`: "a guardian is a second party who can take the account, and the platform must never be one"                                                                       |                                               | **High** — a tracker row overrode two law sections with no ADR. One of them must give                                                  |
| 3   | §13 `:469-476` lists **five** deliberate non-v1 items; §14.8 requires a "§13 socket entry"                                                | Tracker carries **19** sockets                                                                                                                                                            | `features.mjs`                                | **High** — §14.8 is unenforceable as written for 14 of them                                                                            |
| 4   | §8.6 `:410-415` `svc-dex` is a Phase-5 module                                                                                             | §17.5 `:539` "`svc-dex` is **absorbed** into this plane"                                                                                                                                  |                                               | **Medium** — the law contradicts _itself_; `services/svc-dex` runs in compose with no tracker row because of it                        |
| 5   | §22 `:584-587` "Zero-KYC follows custody. **Everywhere. Without exception.** … Nothing is left custodial that can be non-custodial"       | "the §22 sovereign routing rule **does not extend here** — these are Fiat Plane by construction"                                                                                          | `SPEC-PAY-VERTICALS-2026-08-02.md:31-33`      | **Medium** — the spec is right; §22's "without exception" is now false and should say so                                               |
| 6   | §2 `:47-84` monorepo layout                                                                                                               | `svc-edge`, `svc-ws`, `svc-notify`, `packages/venue-contracts`, `packages/venue-adapter`, `packages/market-data`, `packages/i18n`, `packages/exchange-contract` all exist and none appear |                                               | **Medium** — `svc-edge` in particular is the front door and the principal signer; §2's cross-service rule does not describe the system |
| 7   | §8.1 `:379` loans mark from "**svc-trade index prices**"                                                                                  | "svc-trade has no index price … a loan book that marks off `last` inherits every property of `last`"                                                                                      | `services/svc-bank/src/loans/prices.ts:12-21` | **Medium** — the law names a component nobody built, and `bank.loans` is `done` against it                                             |
| 8   | §27 `:755` "**No third-party connectivity library in the money path**"                                                                    | `venue.aggregation` title: "External venue adapters **via CCXT**"                                                                                                                         | `features.mjs:312`                            | **Low** — the note already corrects it; the title is the artefact                                                                      |
| 9   | §25 `:740` `coverage-check` + `tooling/coverage.yaml` is **CI-enforced**                                                                  | Neither exists                                                                                                                                                                            | verified                                      | **High** — the law asserts an enforcement that is not there                                                                            |
| 10  | §12 `:460-467` / §21 `:566-576` phase map has no place for §27–§37                                                                        | §30 `:793` puts Connect + Execution in **Phase 2**; §31 `:809` puts alerts core in **Phase 2**                                                                                            |                                               | **Medium** — the phase tables were never updated for v2.1/v2.2, which is one reason 20 capabilities have no row                        |

---

# C · THE GAPS THAT MATTER, RANKED BY CONSEQUENCE

## C1 · Blocked on a **DECISION nobody has taken** — the expensive kind

These look like engineering backlog. They are questions. Ranked by how much they hold up.

| #     | The question                                                                                           | Rows held                                                                                                                                                                                                                               | Where it is recorded                                                                    | Cost of not answering                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | **Production chain + signing-key custody + deployment record.** Which chain, whose key, recorded where | **~12**: `protocol.smart-accounts` → `.amm` `.escrow` `.router` `.merchant` `.lending`, `bank.sovereign-card`, `blueprint.attestations`, `launch.meme-factory`, `launch.nft`, `socket.p256-verifier`, `socket.userop-differential-test` | `docs/decisions/local-dev-chain.md:75-90`; `DIRECTION…` §8.3                            | The largest blocked subgraph in the repo. Every "ready" protocol row is ready against **anvil**, which `DIRECTION…` §5 says is not `done`                                                              |
| **2** | **INTACHAIN: P0-on-an-L2 or straight to P1?** §17.2 offers both; nothing chose                         | **6**: `chain.mainnet`, `chain.evm`, `chain.validators`, `chain.governance`, `chain.rust-core`, `bridge.canonical`                                                                                                                      | **Nowhere.** One line at `docs/audit/2026-07-30-overnight-wave/WAVE-AUDIT-RESULT.md:39` | Phase 4P is 0/3 and mis-labelled as a dependency block. "Two planes, one economy" is unreachable without `bridge.canonical`                                                                            |
| **3** | **Does a person's account live in `identity.users` or in `member`?**                                   | Everything downstream of the vendored adoption                                                                                                                                                                                          | `VENDORED-OVERLAP-AUDIT.md:246` — _"There is no technical fact that answers it"_        | The ADR adopts a shell that already logs users into the Java `member` table. Every ledger account is keyed on a user id. Unanswered, both halves keep being built                                      |
| **4** | **Does `apps/web` retire, become admin/marketing, or get ported into the Vue shell?**                  | `web.shell` (`done`), `web.terminal` (`wip`), and the 0 rows the vendored shell has                                                                                                                                                     | ADR `2026-08-02…` "Open, and owner-gated"                                               | Two front ends are being built in parallel **right now**, and the tracker scores the one the ADR may retire                                                                                            |
| **5** | **Are §27–§37 in scope?** Execution Empire (10) + v2.2 modules (10)                                    | **20** — every capability in A1.b + A1.c                                                                                                                                                                                                | **Nowhere.** No ADR, no spec, no row                                                    | 20 law-specified capabilities with zero board presence, two of them (Connect/Execution, alerts) phased at **2**. Either the law is amended down or the rows are created — the current state is neither |
| **6** | **`leader_share_bps` and the served-jurisdiction list**                                                | `trade.copy`, `agents.copy-intel`                                                                                                                                                                                                       | `SPEC-SOVEREIGN…:117`, `:148`; `DIRECTION…` §8.10                                       | The spec calls the jurisdiction answer "the single highest-leverage answer". Copy cannot ship its fee leg without the rate                                                                             |
| **7** | **Red envelope / mining orders / promo — do we want these products?**                                  | 3 of the 5 untracked vendored capabilities                                                                                                                                                                                              | `VENDORED-OVERLAP-AUDIT.md:249`                                                         | The audit's own note: _"If no, they are neither rebuild nor adopt — they are **delete**, and that is the cheapest outcome available in this whole document."_                                          |

## C2 · Blocked on an **EXTERNAL party**

| Blocker                                   | What it holds                                                                                               | Recorded honestly?                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Sponsor bank / acquiring BIN**          | `bank.cards`, `bank.sovereign-card`, `socket.live-issuer`, `socket.psp-partners`, `pay.settlement` fiat leg | ✅ `DIRECTION…` §3.3: "Commercial, not code. Do not scaffold a card-capture UI — it drags PCI scope in with it" |
| **External contract audit**               | `socket.contract-audit` → **every mainnet deploy**. `launch.status` returns `audited:false` deliberately    | ✅ `features.mjs:736`, `:884`                                                                                   |
| **Fiat settlement rails**                 | `trade.forex` (row's own note: "no forex market is listed in production"), `bank.ramps`                     | ✅ `features.mjs:289`; `DIRECTION…` §2                                                                          |
| **Sanctions blocklist content (counsel)** | The honesty of the entire permissionless lane                                                               | ⚠️ Code fails closed in prod (`jurisdiction.ts:516-534`), but no row names it. `DIRECTION…` §8.7                |
| **Notification gateway credentials**      | `socket.notify-push`, `socket.notify-email`, `socket.notify-sms`                                            | ✅ Model rows — the adapters exist and refuse by name                                                           |
| **Self-hosted LiveKit + API key**         | `socket.stream-provider`, and therefore every Academy streaming claim                                       | ✅ `features.mjs:859`                                                                                           |
| **Rasterizer + object storage**           | `blueprint.card` — the §7.2 acquisition artefact                                                            | ✅ `features.mjs:551`                                                                                           |
| **RWA / treasury licensing**              | `launch.rwa` (socket), §36 treasury yield (no row)                                                          | Half — `launch.rwa` is honest; §36 has no row                                                                   |
| **Security review of `01_wallet_rpc`**    | ADR calls it "a **precondition** of adoption, not a follow-up"                                              | ❌ No row. 14 controllers holding BTC/ETH/USDT/EOS keys                                                         |

## C3 · Blocked on **CODE** — we can fix these

Ranked by consequence, not size.

| #   | Gap                                                                    | Where                                                                          | Why it matters                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`ops.admin` — every kill-switch is browser `useState`**              | `features.mjs:786`; `apps/admin` has zero test files and makes no network call | **§14.6 makes an admin kill-switch a DoD condition for every module.** No module can honestly pass DoD while this is true. "An operator console that appears to halt the ledger and does not is worse than no console" |
| 2   | **`custody-scan` cannot read Java**                                    | `tooling/ci/custody-scan.mjs:80`, `:101`                                       | Doctrine 10 says the custody boundary is drawn in code and CI-asserted. 949 Java files are outside the walk. The four mutators _are_ covered by `vendor-java-money-scan.mjs`; the non-custody assertion itself is not  |
| 3   | **`workspace-sync` check 7 discovers nothing in `vendor/`**            | `tooling/ci/workspace-sync.mjs:445-447`                                        | The gate written after the `:8090` failure cannot see the tree that caused it. `04_Web_Admin` is currently invisible with no `# no-deploy:` reason                                                                     |
| 4   | **`infra.i18n` — zero importers outside its own package**              | `features.mjs:123`                                                             | **§14.4** requires every user-facing string i18n-keyed. Blocks DoD for every surface, and `apps/web` hardcodes English                                                                                                 |
| 5   | **Tracker default `plane: 'F'`**                                       | `features.mjs:60`                                                              | Inverts the sovereign routing rule for every future row, silently. One-line fix; the alternative is auditing the plane of every row forever                                                                            |
| 6   | **`chain.mainnet` has no `note:`**                                     | `features.mjs:576-581`                                                         | The most consequential row in Phase 4P states a blocker that is wrong. Thirty seconds of writing                                                                                                                       |
| 7   | **`trade.copy` says "profit share"**                                   | `features.mjs:277`                                                             | Renders under "🟢 Claim these now". A wrong row is worse than a missing one                                                                                                                                            |
| 8   | **`blueprint.ownership` — no service consumes `blueprintDeleted`**     | `features.mjs:566`                                                             | §7.2's "deletion truly cascades" is not true end to end. A real `profiles` row keeps a `blueprint_id` pointing at a deleted Blueprint. One-service PR in `svc-identity`                                                |
| 9   | **`protocol.amm` — `ConstantProductPool` has never produced bytecode** | `docs/decisions/local-dev-chain.md:124-130`; `features.mjs:884`                | `swapExactIn` calls an `external` function. Blocks `launch.meme-factory`, `protocol.router`, and is the (wrong) stated blocker for `chain.mainnet`                                                                     |
| 10  | **`bank.loans` is `done` while marking off `last`**                    | `services/svc-bank/src/loans/prices.ts:12-30`; `features.mjs:599`              | The file is honest; the row is not. `SPEC-LENDING-2026-08-02.md` §1 makes the oracle "the whole security model" for M2 — the same failure mode is live on a `done` Fiat-plane row today                                |
| 11  | **`venue.aggregation` title says "via CCXT"**                          | `features.mjs:312`                                                             | Contradicts §27 in the one field a reader sees first                                                                                                                                                                   |
| 12  | **`socket.indexer-stream`** — read path is pull-only                   | `features.mjs:944`                                                             | `packages/market-data` already computes the deltas; missing a subject and a transport                                                                                                                                  |

## C4 · The one structural fix that would prevent the next version of this audit

`tooling/coverage.yaml` + a CI `coverage-check`, per §25 `:740`. It is the only item in this document that would have caught **all forty** A1 gaps automatically, and it is specified in the law as already being enforced.

---

## Method and limits

- Cites are `path:line` against `main` @ `99a7673`. Tracker row ids are `features.mjs` ids.
- "No tracker row" means: no `f(...)` entry whose id, title or note names the capability, verified by keyword grep across all 127 rows.
- `pnpm claim:check` reports "nothing to compare (no changes on this branch)" — this is a docs-only branch touching no owned lane, so no ownership conflict exists for this work. Ownership per row is read from `owner:` in `features.mjs`: `shehzad002` holds M1–M7 (`pay.*`, `trade.futures/otc/copy/algo`, `protocol.*`, `bank.*`, `identity.apikeys`); `Nitro` holds `web.terminal`, `ws.gateway`, `trade.mm-bot`. **No gap in §C1 sits in an agent's lane** — all seven are the owner's.
- Marked **unverified**: whether anyone has scoped INTACHAIN validators or a CometBFT version; whether `svc-bridge` and `svc-chain` would be jurisdiction-gated (neither exists); the exact vendored admin controller count (docs say 58, `find` says 57, `.vue` count is 92).
- This document reports contradictions. It does not resolve them, and it did not edit `INTAFACED_DEFINITIVE_BUILD.md`.
