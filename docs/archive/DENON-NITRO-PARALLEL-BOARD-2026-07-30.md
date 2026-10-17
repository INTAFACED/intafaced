# Denon ↔ Nitro parallel board (full backlog)

**Snapshot:** 2026-07-30 · expand pass (full Denon load + agent-safe Nitro lane)  
**Main tip at first write:** `2fec526` (~**#168**); re-check `git fetch && git log origin/main -1`  
**Open PRs at expand:** re-check `gh pr list` (board PR + any Stream A uiproof)  
**Agent micro-queue:** was **DRAINED** — easy agent invent-work is thin; real mountains remain  
**If this file disagrees with live git / PRs / tracker:** **live wins** — fix this file after.

**Purpose:** give Denon a **full real spine backlog**, and keep Nitro’s agents only on work that does **not** need Nitro’s product judgment.

---

## One-screen split

| Who                                  | What they own                                                                                          | Volume                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **Denon**                            | Decisions + spine product + ops/licence/money architecture                                             | **Large** — this is the heavy column on purpose |
| **Nitro agents (no Nitro judgment)** | Stream A shell polish, honesty UI, WAVE-AUDIT, tracker honesty, already-specified wire-ups             | **Medium** — continuous, not empty              |
| **Nitro human only**                 | Visual product sign-off, counsel/sanctions content, dual-book _policy_ under live demo, go-live yes/no | **Tiny** — few buttons, high stakes             |

**Rule:** if an agent would have to invent a product, legal, ops, or money-model answer → **Denon**.  
If the work is “make the already-decided shell honest and usable” → **Nitro agents**.  
If only Nitro can say “this looks/feels like our product” → **Nitro human**.

---

## How to use (no new tooling)

| Surface                                                    | Job                                                |
| ---------------------------------------------------------- | -------------------------------------------------- |
| **This file**                                              | Judgment split + full ordered backlogs             |
| **`docs/TRACKER.md` / `pnpm tracker ready`**               | Generated feature scoreboard                       |
| **`docs/SPLIT-BOARD.md` + `docs/NITRO-STREAM-A-CLAIM.md`** | File territory (paths / branch prefixes)           |
| **`docs/LIVE-LANES.md`**                                   | Which agent session owns a coding lane _right now_ |
| **`gh pr list` + `origin/main`**                           | What already shipped / is in flight                |

---

## Live truth

| Fact          | State                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| Product UI    | Vendored exchange shell under `vendor/…/05_Web_Front` → **:8090** — **not** `apps/web`                     |
| Money books   | TypeScript ledger only — shell must never sell balances as truth                                           |
| Audit program | Closed for full archaeology; after Denon waves → **WAVE-AUDIT only**                                       |
| AFK cook      | Large agent ship wave roughly **#110–#168** on main — **do not rebuild** (see AFK scoreboard + grind loop) |
| Multi-asset   | `feat/multi-asset-instruments` still **Denon-only** money-enum merge                                       |
| CI            | Re-check live; do not claim green from memory                                                              |

---

# COLUMN A — DENON (full real backlog)

Work Denon (and his agents under his direction) should absorb.  
**Ordered:** finish higher bands before spraying lower bands across many branches.  
**Cadence suggestion for his speed:** up to **2 active coding mountains** + any pure decisions in parallel — not five half-ships.

### A0 · Orient (30–60 min, once)

| #    | Task                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| D0.1 | Read this file + `docs/AFK-COOK-SCOREBOARD-2026-07-30.md` + `docs/GRIND-LOOP-ACTIVE.md` — map what agents already shipped |
| D0.2 | Skim `docs/PEACE-OF-MIND-AUDIT-CURRENT.md` + `docs/POST-MERGE-RESIDUAL-AFTER-86.md`                                       |
| D0.3 | `git fetch && gh pr list && git log origin/main -25` — refuse to rebuild tip                                              |

### A1 · Decisions that unblock go-live shape (do these; do not agent-fake)

| #   | Task                                                                                                             | Why only Denon                                    |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| D1  | **Chart stack licence path** — commercial chart grant **or** move to the Apache path named in `docs/TERMINAL.md` | Legal/product fork → two different workstreams    |
| D2  | **MySQL Connector/J GPL** in proprietary product — swap path (e.g. MariaDB Connector/J) or other allowed plan    | Licence in money path                             |
| D3  | **Merge or refuse** `feat/multi-asset-instruments`                                                               | Ledger asset enum — owner merges money personally |
| D4  | **Wallet secrets / empty keystores / host perimeter**                                                            | Ops secrets, not a drive-by PR                    |
| D5  | **Real payment rails + live chain** (not propped stubs)                                                          | Product infra                                     |
| D6  | **Kill / freeze drill end-to-end** (Nitro only signs off the drill result)                                       | Proof path                                        |
| D7  | **GitHub Actions billing / spending** if CI still dead                                                           | Org human                                         |
| D8  | **Bank / blueprint scope policy** — who gets which scopes (if still a product call anywhere residual)            | Policy, not a blind patch                         |
| D9  | **P2P jurisdiction tier policy** — is `basic` KYC required for offers; honesty of refusal reasons                | Policy + product                                  |

### A2 · Platform spine that must stay honest (ops + custody class)

| #   | Task                                                                                                                 | Notes                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| D10 | Fleet redeploy / runtime truth for protocol · indexer · token mounts and ports                                       | Shell screens stay dark if fleet lagging code           |
| D11 | Pay **rail double-submit** contract when rails become real                                                           | Residual money item                                     |
| D12 | **L2-6 S2S body-bind** design (not drive-by)                                                                         | Before hard multi-service prod                          |
| D13 | Java **custody-first then package rename** strategy (Mongo `_class`, live DB names)                                  | SPLIT-BOARD hazard — scriptable but migration-dangerous |
| D14 | `ops.admin` — listings, fee params, treasury, **kill-switches**                                                      | Operator power surface                                  |
| D15 | `ops.compliance` — screening queues, geo-block, VPN/Tor detection **mechanism** (list _content_ still counsel+Nitro) | Spine mechanism                                         |
| D16 | Secret-scan in CI **when** you choose tooling                                                                        | Optional Track A                                        |

### A3 · Highest-leverage product mountains (tracker)

These are **real multi-PR programs**. Denon owns design + first honest cut.

| #   | Tracker id                                                            | Why Denon                                                                         | Leverage hint             |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------- |
| D20 | `protocol.smart-accounts`                                             | Real chain RPC/factory, not propped honesty                                       | Unblocks **~27** features |
| D21 | `pay.rails`                                                           | Deposit/withdraw rails — money design                                             | Unblocks user-money path  |
| D22 | `pay.gateway` completion                                              | Hosted checkout / merchant path beyond agent partials                             | High money surface        |
| D23 | `trade.futures`                                                       | Perps margin / funding / liquidation                                              | Core trade expansion      |
| D24 | `trade.otc`                                                           | OTC RFQ + staked-tier gate                                                        | Desk design               |
| D25 | `trade.copy`                                                          | Copy trading + profit share                                                       | Risk + audit design       |
| D26 | `trade.algo`                                                          | TWAP / VWAP / POV                                                                 | Execution design          |
| D27 | `trade.mm-bot`                                                        | Internal MM seeding books                                                         | Launch critical           |
| D28 | `trade.ccxt-api` remaining honesty                                    | Agents partialled a lot — finish as **product-complete** CCXT, not “route exists” | Bots                      |
| D29 | `venue.aggregation`                                                   | External venue adapters                                                           | Fabric design             |
| D30 | `ws.gateway` remaining streams                                        | Public depth/tape exist; private/orders/positions posture is security design      | Careful                   |
| D31 | `web.terminal` **backend contracts** charts/hotkeys/sub-accounts need | Shell UI is Nitro; missing _sources_ and spine sockets are Denon                  | Split carefully           |
| D32 | `p2p.merchants`                                                       | Merchant programme                                                                | Product rules             |
| D33 | `token.*` remaining live paths you still want                         | Stake/gov partially cooked — Denon sets what “done” means                         | Money                     |
| D34 | `bank.loans` / `bank.earn` / `bank.cards`                             | Bank plane product                                                                | Money + policy            |
| D35 | `blueprint.card` / `crews` / `ownership`                              | Blueprint product                                                                 | Product                   |
| D36 | `agents.navigator` / `support` / `scanner`                            | Agent fleet product (model-agnostic gateway already doctrine)                     | Product                   |
| D37 | `academy.lobbies` / `paper-trading`                                   | Academy                                                                           | Product                   |
| D38 | `market.vendors`                                                      | Vendor lifecycle + stake slots                                                    | Product                   |
| D39 | `mining.pool`                                                         | Stratum / PPLNS                                                                   | Product                   |
| D40 | `ops.support` / `ops.affiliates` / `ops.analytics`                    | Ops plane                                                                         | Product                   |
| D41 | `ops.notifications` beyond in-app fans                                | Push / email / SMS providers — vendor choice                                      | Ops decision              |
| D42 | `infra.i18n` platform keys (if you want spine-owned i18n law)         | Can share with Stream A for shell strings — Denon owns system law                 | Shared                    |

### A4 · Absorb + gatekeep

| #   | Task                                                                                   |
| --- | -------------------------------------------------------------------------------------- |
| D50 | Self-audit every money PR (recipes, failure tests, no balances outside ledger-client)  |
| D51 | Squash-merge on green CI; delete branch                                                |
| D52 | After each wave: expect Nitro agents to run **WAVE-AUDIT only** — not full archaeology |

### Suggested attack order (so “fast” ≠ chaos)

1. **D0 orient**
2. **D1–D3** (licences + multi-asset) — pure decisions / merge
3. **D10 fleet truth** if anything still 404s at runtime
4. **D20 smart-accounts** _or_ **D21 rails** _or_ **D23 futures** — pick **one** primary mountain
5. Parallel **only** if second mountain does not touch the same services as the first
6. Fill A2/A3 from leverage table in tracker (“unblocks N”)

---

# COLUMN B — NITRO AGENTS (no Nitro judgment required)

Agents may **claim and ship** these without asking Nitro for product taste.  
Still: worktree, one concern per PR, `pnpm verify`, no Stream B edits, no inventing Denon answers.

### B1 · Stream A shell (territory: `feat/app-*` only)

| #   | Task                                                     | Done when                                                                                                 |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| N1  | Browser pass of terminal (screenshots OK)                | Layout / chart chrome / depth seen; bugs filed or fixed                                                   |
| N2  | Order-entry polish                                       | Validation, precision, fee preview, confirm states                                                        |
| N3  | Account panes against **existing** endpoints             | Balances / positions / open orders / history — real data **or** honest empty/unknown (never fake numbers) |
| N4  | Mobile drawer after retheme                              | Usable small screen                                                                                       |
| N5  | Empty + error states every screen                        | Backend down never blank-screens                                                                          |
| N6  | DEX/CEX UI toggle if still incomplete                    | Uses existing backend plane rules — no new custody policy                                                 |
| N7  | Shell copy / i18n keys **inside Stream A regions only**  | No full-file prettier sweeps of shared lang/css                                                           |
| N8  | Cross-stream issues when blocked on proxy/edge/`main.js` | Title: `[cross-stream] <file> — <what>`                                                                   |

**Not agent-autonomous if it needs spine:** candle **seed job** in Java/market, new edge routes, multi-asset, chart **licence** choice → file for Denon or issue #109 class.

### B2 · Hygiene & trust (always safe)

| #   | Task                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------- |
| N10 | After Denon merges a wave → run `docs/WAVE-AUDIT.md` (delta only) and update PEACE/residual if scoreboard changes |
| N11 | Tracker honesty — notes match main; never mark Denon-only residual “done”                                         |
| N12 | Brand / custody / workspace-sync reds that are pure doc or known mechanical fixes                                 |
| N13 | Babysit open Nitro PRs (CI, conflicts) without expanding scope                                                    |
| N14 | Keep this board + LIVE-LANES current when claims move                                                             |

### B3 · Explicitly forbidden to “finish” as agent-done

| Item                                                    | Who               |
| ------------------------------------------------------- | ----------------- |
| Licence path answers                                    | Denon             |
| Multi-asset merge                                       | Denon             |
| Real rails / live chain / kill drill                    | Denon             |
| Invented candles, balances, factory addresses, CI green | Nobody            |
| Sanctions **list content**                              | Nitro + counsel   |
| “Shell balance is the real book” demos                  | Forbidden for all |

---

# COLUMN C — NITRO HUMAN ONLY (tiny)

Agents prepare evidence; **Nitro decides**.

| #   | Task                                                    | Why human     |
| --- | ------------------------------------------------------- | ------------- |
| H1  | **Visual sign-off** on rebrand / shell look             | Taste         |
| H2  | **S8 look tour** (Stream A claim)                       | Taste         |
| H3  | Dual-book **discipline under live demo** (policy habit) | Business risk |
| H4  | Sanctions list **content** with counsel                 | Legal         |
| H5  | Go-live / real customer money yes-no                    | Owner         |
| H6  | Kill-drill **sign-off** after Denon runs it             | Owner         |

---

## Tracker ready list — routing (snapshot; re-run on tip)

| Tracker id                                                                                                | Route                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `infra.i18n`                                                                                              | Shared — Denon system law / Nitro shell strings               |
| `trade.futures` `trade.otc` `trade.copy` `trade.algo` `trade.mm-bot` `trade.ccxt-api` `venue.aggregation` | **Denon**                                                     |
| `web.terminal`                                                                                            | **Split** — shell UI Nitro; missing sources/spine Denon       |
| `p2p.merchants`                                                                                           | **Denon**                                                     |
| `protocol.smart-accounts`                                                                                 | **Denon**                                                     |
| `blueprint.*` `bank.*` `agents.*` `academy.*` `market.vendors` `mining.pool`                              | **Denon**                                                     |
| `ops.support` `ops.affiliates` `ops.compliance` `ops.analytics` `ops.admin` `ops.notifications`           | **Denon** (Nitro agents may do pure UI later when APIs exist) |

---

## Message Denon can paste (full backlog version)

See bottom of PR description / Telegram pack Nitro sends — keep this file as SoT.

---

## Enhanced director prompt (Nitro → any agent)

```
You work for Nitro on INTAFACED (Phantom-X-007/intafaced). Non-technical director; you run git/PR (operator mode). Denon = experienced spine builder.

GOAL
- Give Denon the FULL real spine backlog (decisions + mountains).
- Nitro agents only ship work that needs NO Nitro product judgment.
- Never invent Denon answers (licences, multi-asset, rails/chain, kill drill, money models).

SOURCE ORDER (live wins)
1) docs/DENON-NITRO-PARALLEL-BOARD-2026-07-30.md
2) docs/LIVE-LANES.md
3) START-HERE · PEACE · residual · GRIND-LOOP / AFK scoreboard on origin/main
4) TRACKER + gh pr list + git fetch origin/main
5) Law + AGENTS.md + agent protocol

CLASSIFY BEFORE CODING
- Needs product/legal/ops/money-model fork? → Denon column. Stop. Update board if missing.
- Stream A shell polish / honesty / WAVE-AUDIT / tracker honesty? → Nitro agent column. Ship.
- Needs Nitro taste (look sign-off, go-live, sanctions content)? → prepare evidence, ask Nitro once.

TERRITORY
- Nitro agents: vendor shell pages/components/images, App.vue, routes.js — feat/app-*
- Never services/packages/edge/compose/Java/proxy/main.js without [cross-stream] issue
- Shell ≠ books. No fake candles/balances/CI.

WHEN ASKED “what should we do?”
Refresh live state → Denon’s next recommended mountain + our next agent-safe item + one recommended move.
```

---

## Maintenance

- After Denon closes a D-row: mark done here + residual/PEACE if trust floor changes.
- After agent ships: high water in grind/scoreboard — don’t duplicate full PR tables here.
- Re-verify SHA + open PRs every orient (60s).
