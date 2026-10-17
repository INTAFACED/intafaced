# AFK cook scoreboard — 2026-07-30

**Operator:** Nitro AFK · full autonomous cook  
**Intent:** fix everything fixable, audit, front-run, ship, merge. More volume than 07-29 night.

## Shipped this cook

| PR   | What                                                                                  |
| ---- | ------------------------------------------------------------------------------------- |
| #118 | Brand-scan fix (PARALLEL-OPS model vendor name) + delta audit docs                    |
| #119 | **Private order stream** — `orderUpdated` event, trade publish, `/private/stream` JWT |
| #120 | **Payment links** — createLink + public resolveLink + migration 0002                  |

Plus prior night still on main: #110–#117 (yield/buyback, apikeys, edge ifc\_, subaccounts, parallel-ops).

## Audit (local)

- Brand: **was red on main** → fixed #118
- Custody / vendor-shell / tracker: green (re-check after product ships; tracker:check may still want `pnpm tracker` if markdown stale)
- GitHub Actions: **still billing-blocked** (jobs never start) — human Billing & plans
- Residual money table unchanged for Denon-owned items (rails, licences, counsel list)

Full: `docs/audit/AFK-WAVE-2026-07-30.md`

## Unspoken needs addressed

| Need                               | What we did                                     |
| ---------------------------------- | ----------------------------------------------- |
| Don't leave red doctrine           | Fixed brand scan failure introduced by ops docs |
| Front-run Denon product holes      | Private orders + payment links                  |
| Peace of mind without reading code | Scoreboards + claim board                       |
| More volume than 10-minute cook    | Multiple sequential product PRs + audit         |

## Still open (honest)

| Item                               | Why                                                            |
| ---------------------------------- | -------------------------------------------------------------- |
| GitHub CI green                    | Org payment / spending limit — **not agent-fixable**           |
| Positions product                  | Honest `[]` REST only; futures later                           |
| Hosted checkout UI                 | Links + minimal HTML exist; full merchant UI does not          |
| protocol.smart-accounts            | Chain non-propped                                              |
| Real rails / kill drill / licences | Denon + counsel                                                |
| DoD gate svc-notify OTEL           | Pre-existing red — agent queue #1                              |
| tracker:check                      | May still be red if TRACKER.md markdown stale — agent queue #2 |

## Config notes for Denon

- svc-ws private path needs `JWT_ACCESS_SECRET` (same as identity/edge)
- pay links need migration `0002_pay_payment_links.sql` applied on deploy

## Free mountains next (historical — FOSSIL; do not treat as open queue)

Items 1–4 below shipped during the AFK cook (#156 OTEL, tracker honesty waves, #157 disputed fan, #158 revoke). Kept only so earlier scoreboard links do not 404 meaning. **Living open list is the post-DRAINED table at the end of this file + human blockers.**

1. ~~svc-notify OTEL~~ → **DONE #156**
2. ~~tracker:check stale~~ → honesty waves **DONE**
3. ~~p2pTradeDisputed notify~~ → **DONE #157** (openedBy only — intentional)
4. ~~identity subAccounts.revoke~~ → **DONE #158**
5. Human: **fix GitHub Actions billing** (still open)
6. Prefer skip: private balance WS, pay.public-api (product)

## Living free mountains (2026-07-30 mega-audit)

- Human: GitHub Actions billing / zero-step CI failures
- Product: candle aggregation, futures positions, real pay rails, chain factory deploy
- ~~Residual agent: identity S2S ownership gate for sub-account orders~~ → wired (identity internal + trade placeOrder gate)

## Grind continuation (same AFK)

| PR   | What                                                     |
| ---- | -------------------------------------------------------- |
| #122 | Private **fills** stream (`fillSettled` + channel=fills) |
| #123 | **orders.history** terminal orders                       |
| #124 | Payment links **list + deactivate**                      |

## Wave B (parallel agents + continuous audit)

| PR   | What                                             |
| ---- | ------------------------------------------------ |
| #126 | Grind plan + audit cadence                       |
| #127 | **orders.cancelAll**                             |
| #128 | **protocol factory honesty** (no fake addresses) |
| #129 | **svc-notify** in-app inbox + 3 event fans       |

**Audit:** `docs/audit/WAVE-B-2026-07-30.md` — all local doctrine gates green.

## Wave C (parallel)

| PR        | What                                                             |
| --------- | ---------------------------------------------------------------- |
| #130      | Wave B audit gates green                                         |
| #131      | **Public REST** `/api/v1/markets` + orderbook (ccxt-api partial) |
| #127–#129 | cancelAll · protocol honesty · svc-notify                        |

**Audit policy in force:** light gates every PR; wave audit every 3–4 ships (`docs/GRIND-PLAN-2026-07-30.md`).

## Compaction survival

**Loop file:** [`GRIND-LOOP-ACTIVE.md`](GRIND-LOOP-ACTIVE.md) — paste prompt + queue. Next chat continues without Nitro.

## Loop after compact

| PR        | What                                                  |
| --------- | ----------------------------------------------------- |
| #135–#137 | Grind loop docs + queue refresh                       |
| #139      | Pay **hosted checkout** HTML for payment links        |
| #140      | CCXT private REST **create/cancel/get/closed/trades** |

**Continue:** `docs/GRIND-LOOP-ACTIVE.md` · scheduler every 45m

## Wave D (bots trade + notify + honest empties)

| PR        | What                                                                                     |
| --------- | ---------------------------------------------------------------------------------------- |
| #141–#144 | Loop docs after checkout/REST; cancel-all + fees; fills.forOrder; pre-compact high water |
| #145      | **Private REST account/balance** (ledger projection, self-only)                          |
| #146      | **Public OHLCV** — honest empty until candle job                                         |
| #147      | **GET /positions** — honest `[]` until futures                                           |
| #148      | Notify fans: rankUpdated · stakeCreated · p2pEscrowReleased                              |
| #149      | Tracker: **trade.convert** done (mounted + money-path tests)                             |
| #150      | Notify fan: **p2pEscrowRefunded**                                                        |
| #151      | Docs: Wave D grind loop high-water + compaction survival                                 |
| #152      | Tracker honesty wave D — notes match main code                                           |
| #153      | Docs(audit): Wave D doctrine scan log with real exit codes                               |
| #154      | SQL **symbol filter** on account/trades + positions health log                           |

**Audit:** `docs/audit/WAVE-D-2026-07-30.md` · scan log: `docs/audit/WAVE-D-SCANS-2026-07-30.md` — brand/custody/vendor-shell/workspace green at Wave D; OTEL/tracker reds cleared in Wave E.

## Wave E (queue clear → DRAINED)

| PR   | What                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| #155 | Docs: grind loop high water past #154 + AFK scoreboard                                                                         |
| #156 | **svc-notify OpenTelemetry** + tracker:check green                                                                             |
| #157 | Notify fan: **p2pTradeDisputed** (openedBy only)                                                                               |
| #158 | Identity **subAccounts.revoke** soft-disable                                                                                   |
| #159 | Loop + scoreboard **DRAINED**; sub-account tracker honesty                                                                     |
| #160 | Docs(audit): Wave E doctrine scan log with real exit codes                                                                     |
| #161 | Tracker honesty: ops.notifications lists **p2pTradeDisputed**; Status **DRAINED (agent queue)**                                |
| #162 | **Terminal public trade tape** — `LiveTradeTape` ← svc-ws `channel=trades` (decimal-string prints; charts still honest socket) |
| #163 | CCXT optional **`since` (ms)** on account/trades · closed orders · public trades                                               |

### Post-DRAINED product (queue re-checked)

First DRAINED claim was after product **#158** / drain docs **#159–#161**. Then:

| PR   | What                                                                          |
| ---- | ----------------------------------------------------------------------------- |
| #162 | **web.terminal** public trade tape wired (tracker note already honest on tip) |
| #163 | Bot history paging: `since` filters on private + public trade REST            |

**Reassess:** still **DRAINED (agent queue)** — no further agent micro product; next fire = babysit open PRs / human blockers only.

### Unspoken needs (post-#163 / tip ≥ #163)

| Need                                 | Status                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Volume + quality without Nitro       | Product through **#163** after drain re-check; no padding ceremony                                                                              |
| Bots can trade (CCXT public+private) | Balance · positions empty · OHLCV empty · mytrades `?symbol=` + **`since`** · closed **`since`** · public tape **`since`** · write path on main |
| Terminal surface                     | Depth live · **public trade tape live (#162)** · charts still honest empty (no candle invent)                                                   |
| In-app notifications                 | Fans include rank/stake/p2p lock/release/refund + **dispute opened** (openedBy)                                                                 |
| Continuous light gates + wave audits | Local green at drain: brand/custody/vendor-shell/workspace/dod-gate/tracker:check                                                               |
| Peace-of-mind scoreboard             | This file + GRIND-LOOP-ACTIVE product high water **#162–#163** · tip **#163** · **Status DRAINED (agent queue)**                                |
| Compaction survival                  | Loop file still law for every 45m fire                                                                                                          |
| Never fake human blockers            | CI billing · chain factory · futures · candles · push/email/SMS still human/later                                                               |

### Agent queue disposition

| Item                       | Result                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| svc-notify OTEL            | **DONE** #156                                                                |
| tracker:check              | **DONE** #156 (+ sub-account note #159; p2pTradeDisputed consumer note #161) |
| p2pTradeDisputed fan       | **DONE** #157                                                                |
| pay.public-api             | **SKIP**                                                                     |
| Private balance WS         | **SKIP**                                                                     |
| subAccounts.revoke         | **DONE** #158                                                                |
| Terminal public trade tape | **DONE** #162 (post-DRAINED)                                                 |
| CCXT `since` filters       | **DONE** #163 (post-DRAINED)                                                 |
| Reassess DRAINED           | **Met again** — **DRAINED (agent queue)** after #162/#163 re-check           |

### Still open (honest — not agent product)

| Item                                         | Why                                      |
| -------------------------------------------- | ---------------------------------------- |
| GitHub CI green                              | Org billing / spending limit — **human** |
| Futures / real positions                     | Honest `[]` only                         |
| Candle aggregation / OHLCV data              | Honest empty until real job              |
| Terminal charts / hotkeys / sub-accounts     | Tape live; chart socket remains honest   |
| protocol.smart-accounts chain                | Factory honesty only — not propped       |
| Push / email / SMS                           | §13 sockets                              |
| venue.aggregation implementations            | Large phase                              |
| ops.admin real wiring                        | Browser-local only — large phase         |
| Real rails / kill drill / licences / counsel | Denon + counsel                          |

## 45m re-check (post-#165 / #138)

| Event                | Result                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Local doctrine gates | brand/custody/vendor-shell/workspace/dod-gate/tracker:check **green** after brand scrub of #138 docs                  |
| Open PRs babysit     | **#138** admin-merged (was only open product-adjacent docs PR)                                                        |
| Brand regression     | #138 landed with model-provider + upstream-shell path names → **scrubbed same fire** (planner/executor · `vendor/*/`) |
| Agent product queue  | still **empty** — DRAINED                                                                                             |

**Loop file:** [`GRIND-LOOP-ACTIVE.md`](GRIND-LOOP-ACTIVE.md) · **Status: DRAINED (agent queue)** · product high water **#162–#163** · tip through **#165 + #138** · scheduler 45m re-check only

## 45m re-check (post-#167)

| Event               | Result                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| Open PR babysit     | **#167** admin-merged — trade migration backfill `display_name` before CHECK (fleet-down on non-empty markets) |
| Local verify        | migration-check green; brand green; CI billing-blocked                                                         |
| Agent product queue | still **DRAINED** — ops fix only                                                                               |

**Loop file:** [`GRIND-LOOP-ACTIVE.md`](GRIND-LOOP-ACTIVE.md) · tip **#167** · Status **DRAINED (agent queue)**

## 45m re-check (post-#169 / #172)

| Event               | Result                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| #169                | Admin-merged after main conflict resolve — Stream A `ui:boot`                       |
| #172                | Admin-merged after conflict resolve — Playwright harness + design bar               |
| PROOF.md            | **Honest unverified** in agent sandbox (Chromium SEGV) — needs desktop Terminal run |
| Backend micro-queue | still **DRAINED**                                                                   |

**Loop file:** [`GRIND-LOOP-ACTIVE.md`](GRIND-LOOP-ACTIVE.md) · tip **#172** · Status **DRAINED (backend micro-queue)**

## 45m re-check (post-#175 / #177)

| Event         | Result                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------ |
| #175          | Admin-merged — four Stream A agent packages (live-probed); brand allowlist for shell paths |
| #176–#177     | Already on tip — mega-audit P0/P1 + PEACE tip SHA                                          |
| Open PRs      | none after merge                                                                           |
| Product queue | still **DRAINED**                                                                          |

**Loop file:** [`GRIND-LOOP-ACTIVE.md`](GRIND-LOOP-ACTIVE.md) · tip **#175+** · Status **DRAINED (agent product queue)**

## 45m re-check (spine P0 babysit #182–#186)

| PR   | Result                                                                     |
| ---- | -------------------------------------------------------------------------- |
| #185 | Merged — empty order book → empty depth, not 502 (7 matching-client tests) |
| #183 | Merged P0 — sandbox rails refused in enforced envs (163 rail tests)        |
| #184 | Merged — S2S body-bind (47 contracts + 17 ledger s2s tests)                |
| #186 | Merged P0 — kill-switches reachable (51 edge tests)                        |
| #182 | Merged — uiproof B1–B5 + Pass3; brand-scrubbed docs                        |
| Open | none                                                                       |

**Loop:** tip **#186** · Status **DRAINED (agent product queue)** · human: CI billing still

## Spine landings #201–#202 (2026-07-30 AFK babysit)

| PR   | What                                                      | Proof                                               |
| ---- | --------------------------------------------------------- | --------------------------------------------------- |
| #201 | CCXT contract truth (errors, TICK_SIZE, OHLCV from fills) | CI all green · local svc-trade 161 pass             |
| #202 | Bank loans (purposed collateral, LTV ladder, loanReserve) | CI all green · local bank 58 + ledger 99 · DoD gate |

**Agent product micro-queue:** still empty. **Do not re-ship #110–#202.**

## Spine landings #206–#211 (2026-07-30 AFK babysit)

| PR   | What                                | Proof                            |
| ---- | ----------------------------------- | -------------------------------- |
| #206 | P0 trade rank-perks S2S credentials | CI all green                     |
| #207 | notify multi-channel honest refuse  | local notify 45 pass             |
| #208 | academy lobbies rank host rights    | local academy 50 pass            |
| #209 | venue §27 sequenced/gap fabric      | local adapter 137 + contracts 29 |
| #210 | protocol local EVM + CREATE2        | local protocol 196 pass          |
| #211 | test DB isolation                   | CI all green                     |

**Agent product micro-queue:** still empty. **Do not re-ship #110–#211.**

## Spine landings #213–#214

| PR   | What                                                  |
| ---- | ----------------------------------------------------- |
| #213 | Vendored exchange audit — 0% used, decision open      |
| #214 | Hosted checkout; sandbox rails refused on public path |

**Do not re-ship #110–#214.** Agent micro still DRAINED.

## Spine landings #216–#218 + O1+O2 overnight (2026-07-30)

| PR   | What                                                        |
| ---- | ----------------------------------------------------------- |
| #216 | Blueprint share card + false ownership `done` corrected     |
| #217 | Token factory on dev chain (immutables ≠ artefact bytecode) |
| #218 | Indexer read models on real chain + wire-level test fix     |

**Overnight posture (Nitro):** **O1+O2** — babysit with hard merge matrix (money / review-hold = no Nitro merge) + Stream A / hygiene parallel. Backend micro still **DRAINED**. Law: `docs/GRIND-LOOP-ACTIVE.md`. Plan: `docs/OVERNIGHT-LOOP-PLAN-2026-07-30.md`.

**Do not re-ship #110–#218.**

| #221 | fix(ci): main red from missing DevVenue artefacts (#217/#218) |
