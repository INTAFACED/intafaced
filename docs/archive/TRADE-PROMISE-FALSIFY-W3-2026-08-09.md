# TRADE promise falsification — Wave 3 (2026-08-09)

**Scope:** Engine B — trade / matching MUST·NEVER claims vs tip code.  
**Tip base:** `/private/tmp/sov-main-tip` (treat as `origin/main` harvest tree).  
**Residual focus:** after wave1–2 merges (#1097–#1169, #1145 ADR, #1136 liq, #1161 closing, #1163 staleness, #1164 depth floor, #1165 MM mid, #1148 second venue).  
**Method:** claim → code path → test seal → PROVED | BROKEN | PARTIAL. Money path first.  
**Not Nitro/Denon owner numbers:** agent-implementable units only in §Top 10.

---

## Verdict (one line)

Money-path law is largely **sealed where mounted**; the largest remaining breaks are **unmounted or unsealed schedules** (TWAP burst + no job host, copy fee-share race, funding rate unbound, funding period membership, OTC mid no age, grace/margin-call transport) — not the dust-mark / caller-price class already fixed in wave1–2.

---

## Claim register

Legend: **PROVED** = claim holds + test/code path named · **BROKEN** = claim vs actual · **PARTIAL** = mechanism exists, done-bar incomplete · **DORMANT** = broken if mounted / env-on.

---

### A · Spot order path (`services/svc-trade/README.md` + `spot/trade-service.ts`)

| #   | Claim (source)                                                                     | Status               | Evidence                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Hold **before** engine submit; never unfunded order on book                        | **PROVED**           | `trade-service.ts` place path: intent row → `orderHold` → matching submit; tests `trade-service.test.ts` “creates NO order row and never reaches the engine” on refused hold; chaos/properties suites for single hold / single settle.                    |
| A2  | Market buy funded at `bestAsk × (1+slippage)`, submitted as marketable IOC         | **PROVED**           | README + risk/hold path; refuse empty book tested.                                                                                                                                                                                                        |
| A3  | One release per order, fixed sequence `0`                                          | **PROVED**           | README + finalize path; cancel-twice tests.                                                                                                                                                                                                               |
| A4  | `tradeFill` before understating consumed; fee-exhaust refuses **before** fill rows | **PROVED**           | `fees.ts` header + `fees.test.ts` / `trade-service.test.ts` fee-exhaust branch.                                                                                                                                                                           |
| A5  | Seeded volume excluded from public tape / candles                                  | **PROVED**           | `candles.ts` SQL `seeded = false` both legs; seed place kill-switch SD-4.                                                                                                                                                                                 |
| A6  | Cancel never blocked by kill-switch / halted market                                | **PROVED**           | README + risk tests; cancel out of halted market covered.                                                                                                                                                                                                 |
| A7  | Stops refused (funding unsolved)                                                   | **PROVED**           | `risk.test.ts` + place path `trade.order_type_unsupported`.                                                                                                                                                                                               |
| A8  | CX-9 reconcile: open+engine no hold fail-closed                                    | **PROVED**           | `order-route-reconcile.test.ts`.                                                                                                                                                                                                                          |
| A9  | Exactly-once place with `clientOrderId`                                            | **PROVED**           | chaos F1; README CX-11. Unsafe without id stated honestly.                                                                                                                                                                                                |
| A10 | Scheduled engine↔ledger `/reconcile` caller on trade                               | **BROKEN** (ops gap) | Matching has pure `POST /reconcile` (`svc-matching/README.md`); trade has **per-order** `reconcileOrder` only. No scheduled counterpart sweep — handoff still `docs/ENGINE-LEDGER-RECONCILE-HANDOFF.md`. Strands money if sides diverge and nobody polls. |

---

### B · Matching (`services/svc-matching/README.md` + D-S-06)

| #   | Claim                                                               | Status                    | Evidence                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | No balances / no ledger posts                                       | **PROVED**                | README Ledger table empty; `money_path=false` tracing.                                                                                                                                                                              |
| B2  | Price-time priority; fill = maker price                             | **PROVED**                | `book.ts` + `book.test.ts`.                                                                                                                                                                                                         |
| B3  | Journal inputs before book move; recovery emits nothing             | **PROVED**                | `engine.test.ts`.                                                                                                                                                                                                                   |
| B4  | Duplicate id guard only for **live** resting/stop orders            | **PROVED** (honest scope) | README “what the guard actually covers”; caller SoT is trade.                                                                                                                                                                       |
| B5  | Self-trade = cancel-oldest; never both sides of fill                | **PROVED**                | book tests.                                                                                                                                                                                                                         |
| B6  | Fiat finality = **ledger post**, not engine match (D-S-06)          | **PARTIAL**               | Trade settles fills to ledger; private REST maps order status from **order store** (filled after settle path). No cross-plane blotter yet. Done bar “pending until posted on failure path” not fully surface-audited outside trade. |
| B7  | Reconcile refuses money-stranding cases, auto only unfunded pending | **PROVED** (engine half)  | `reconcile.ts` table; trade scheduled caller still missing (A10).                                                                                                                                                                   |

---

### C · Futures risk / mark (ADR 2026-08-05 + 2026-08-07)

| #   | Claim                                                              | Status                     | Evidence                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Price that moves money never from request body                     | **PROVED**                 | `position-service.ts` header; `private-rest.ts` `PRICE_FIELDS` + `trade.price_not_accepted`; open/close have no price params.                                                                                                                                                     |
| C2  | Missing mark → refuse value (not zero)                             | **PROVED**                 | open path `markFor` 503; mark-policy tests.                                                                                                                                                                                                                                       |
| C3  | Dark feed voluntary exit → `closing`, not trap                     | **PROVED**                 | ADR 08-07 done bar: `close()` freezes; tests in `position-service.test.ts` (liq/funding skip closing); migrations `0008`/`0009`.                                                                                                                                                  |
| C4  | Profit payout requires payout-grade mark + armed deviation breaker | **PROVED**                 | `requirePayoutGrade` + `accepted_mark` basis under row lock; regression comments (4.95M USDT, dust 2k).                                                                                                                                                                           |
| C5  | Depth mark size-aware (absolute + relative floor)                  | **PROVED**                 | `mark-from-depth.ts` `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` + `DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL`; `orderable-path.test.ts` dust via real order path.                                                                                                                             |
| C6  | Venue mark size + age                                              | **PROVED**                 | `mark-from-venue.ts` + #1163 tests `mark-observed-at.test.ts`.                                                                                                                                                                                                                    |
| C7  | Second venue `bybit-spot` public only                              | **PROVED**                 | README venue section + fabric.                                                                                                                                                                                                                                                    |
| C8  | Leverage capped (default 10×)                                      | **PROVED** (post residual) | `initial-margin.ts` `DEFAULT_MAX_LEVERAGE='10'`; `checkLeverage`; `orderable-path.test.ts` leverage suite. **Note:** BUILD-STOP N2 is stale if tip includes this — re-derive before quoting owner board.                                                                          |
| C9  | Isolated margin only                                               | **PROVED**                 | cross margin refused at REST; schema/storage tests.                                                                                                                                                                                                                               |
| C10 | Funding: never invent rate; skip ≠ zero rate                       | **PROVED**                 | `funding-tick.ts` + tests; skip table + settled_no_legs.                                                                                                                                                                                                                          |
| C11 | Funding period id never from poll clock alone                      | **PROVED**                 | `internal-funding-rate.ts` requires periodId/periodStartIso; future asOf refused.                                                                                                                                                                                                 |
| C12 | Funding rate magnitude **bounded**                                 | **BROKEN**                 | No cap in `planFundingSettlement` / publish path — any finite decimal accepted. BUILD-STOP D2 still true: `"1000000"` charges 1e6 × notional. Largest unbound money lever on funding.                                                                                             |
| C13 | Unsettleable period **blocks next**                                | **PARTIAL / weak**         | Skips do **not** block later settle (by design for oracle-down). There is no product gate that blocks period N+1 when N failed mid-post beyond ledger idempotency. Membership residual (C14) can still double-charge payers.                                                      |
| C14 | Period membership = positions open **as of period**                | **BROKEN**                 | Explicit residual in `funding-settlement.ts:31-46` header: loader is “open now”; open-between-fail-and-replay adds legs → ledger vs `margin_current` divergence for **payers**.                                                                                                   |
| C15 | Margin call delivery required before grace / seizure               | **PARTIAL**                | Ladder reports `margin-call` but **no transport** (`maintenance-ladder.ts:95-100`). Correctly does **not** start grace (honest). Full ADR done bar “grace does not start without transport” is held by **not implementing grace** — product incomplete, not a silent seizure bug. |
| C16 | Partial liquidation ladder depth-referenced                        | **PROVED** (mechanism)     | `maintenance-ladder.ts` + tests; wired via `deps.ladder` on tick. Defaults are **placeholder** §8 numbers (owner) — mechanism agent-landed. Legacy full-close remains if ladder not wired.                                                                                        |
| C17 | Insurance fund listing gate / fund capitalisation                  | **BROKEN** (product)       | Planner can attribute shortfall to insurance leg; no listing gate that empty fund ⇒ no futures list (DIRECTION). Agent unit: fail-closed when insurance account underfunded on bankrupt rung (bound check), not invent fund policy.                                               |
| C18 | Profit source named + refuse overdraw                              | **PROVED**                 | `profit-source.ts`; boot refuses open without config; bound tests.                                                                                                                                                                                                                |

---

### D · Algo / TWAP (ADR 2026-08-04 + 2026-08-08 overdue)

| #   | Claim                                                                                                      | Status                     | Evidence                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Parent holds no value / no position                                                                        | **PROVED**                 | engine header; no ledger in algo path; children via `placeChild` → spot place.                                                                                                                                                                                                                        |
| D2  | Empty book = miss, not fabricated progress                                                                 | **PROVED**                 | `tick` liquidity miss; tests.                                                                                                                                                                                                                                                                         |
| D3  | Mark unusable → halt                                                                                       | **PROVED**                 | mark-gate.                                                                                                                                                                                                                                                                                            |
| D4  | Principal missing after restart → halt, not burn plan                                                      | **PROVED**                 | #1107 path in `twap-engine.ts` `algo_principal_unavailable`.                                                                                                                                                                                                                                          |
| D5  | **Interval is the promise** — never place two children closer than `sliceIntervalMs`; re-space from resume | **BROKEN**                 | ADR 2026-08-08 Accepted. Code still: `dueAt = startedAt + nextSliceIndex * sliceIntervalMs` (`twap-engine.ts:226`). Resume only clears pause (`:169-179`), does **not** re-base schedule. Measured defect (9 slices / 8s) still true if ticked. **No test asserts min spacing after overdue resume.** |
| D6  | Resume returns new projected end; refuse >2× duration                                                      | **BROKEN**                 | Not implemented.                                                                                                                                                                                                                                                                                      |
| D7  | Tick outage distinguishable from user pause on parent                                                      | **BROKEN**                 | No outage field; only `pausedAt` / status.                                                                                                                                                                                                                                                            |
| D8  | Cancel: children cancelled **transactionally** with parent status                                          | **BROKEN**                 | `cancel` loops `cancelChild` then sets cancelled (`:193-201`). Throw mid-loop → parent stays active, may keep placing. ADR explicitly named this engineering defect.                                                                                                                                  |
| D9  | Cancel after restart cancels live children                                                                 | **BROKEN** (risk)          | Parent can flip cancelled while children live if cancelChild no-ops / hydrate incomplete — BUILD-STOP §4 item 3. Cancel disposition not row-locked with book.                                                                                                                                         |
| D10 | Scheduler mounted when algo enabled                                                                        | **BROKEN** (dormant money) | `tickAllAlgos` exists on TradeService (`:2136`) but **no job host / index caller** (grep: only definition + comments). Create returns 201; **zero children ever** unless something external calls tick. Mount without D5–D9 fix = worse than dead.                                                    |

---

### E · Copy (D-S-03)

| #   | Claim                                    | Status     | Evidence                                                                                                                                                                                   |
| --- | ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Fee-share refuse-closed without §8 rates | **PROVED** | `fee-share-law.ts`; tests.                                                                                                                                                                 |
| E2  | Exposure cap cumulative (not signed net) | **PROVED** | #1110 correction; `copy-service.test.ts` sell spends budget.                                                                                                                               |
| E3  | Earnings cap holds under concurrency     | **BROKEN** | `copy-service.ts:208-228` **documents the race**: read → post → write, no lock. Ledger keys safe; **counter over-pays**. Module header: not mount-safe. **No copy routes in `router.ts`.** |
| E4  | Re-follow does not reset earnings        | **PROVED** | test present.                                                                                                                                                                              |

---

### F · OTC (D-S-02)

| #   | Claim                                        | Status                  | Evidence                                                                                                                                                                  |
| --- | -------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Mid never from caller                        | **PROVED**              | #1097; server mid-source.                                                                                                                                                 |
| F2  | Desk law unpublished → refuse                | **PROVED**              | `desk-law.ts`.                                                                                                                                                            |
| F3  | Settle ids derived (no double-hold on retry) | **PROVED**              | #1097 residual fix.                                                                                                                                                       |
| F4  | Mid not stale / age-gated                    | **BROKEN** (ops socket) | `otc/mid-source.ts:82-100` — fixed map at boot, **no asOf**. Production must leave `TRADE_OTC_MIDS` empty until live feed. Same economic hole as caller price if env set. |

---

### G · MM / house desk (ADR 2026-08-08)

| #   | Claim                                                                        | Status                  | Evidence                                                                                |
| --- | ---------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| G1  | Internal quotes may seed; may never become mark (size refuse when only dust) | **PROVED** (size path)  | Depth floors refuse dust books for payout marks.                                        |
| G2  | Venue MM mid not size/age blind                                              | **PROVED** (wave #1165) | `mm/mid-source.ts` `createVenueMmMidSource` reuses venue size + `acceptableForMarking`. |
| G3  | No tenant privilege in matching                                              | **PROVED** (default)    | No house-tenant branch in matching; house-tenant build blocked by ADR.                  |
| G4  | Hard exclusion of internal quotes from mark derivation                       | **OPEN owner**          | ADR Q3; not agent default. Size floor is partial stand-in.                              |

---

### H · Algo law extras / convert

| #   | Claim                                          | Status              | Evidence                                                 |
| --- | ---------------------------------------------- | ------------------- | -------------------------------------------------------- |
| H1  | Convert / TWAP spot-only (`assertSpotSurface`) | **PROVED**          | risk + orderable-path tests refuse futures convert/TWAP. |
| H2  | Parent progress = sum of child fills only      | **PROVED** (design) | parent has no fill field; present path sums children.    |

---

## Wave1–2 residual status (named merges)

| Merge theme                | Residual after tip?                                              |
| -------------------------- | ---------------------------------------------------------------- |
| #1097 OTC mid + settle ids | Mid **staleness** still socket; caller mid fixed.                |
| #1098 / funding keys       | Pair keys good; **membership** residual remains.                 |
| #1107 TWAP principal halt  | Fixed; **spacing + mount** not.                                  |
| #1136 / ladder             | Mechanism + tests; grace/transport + insurance fund policy open. |
| #1145 / #1161 closing      | Sealed for dark exit.                                            |
| #1163 venue age            | Sealed.                                                          |
| #1164 relative depth       | Sealed on mark path.                                             |
| #1165 MM mid gates         | Sealed on venue MM mid.                                          |
| #1148 bybit-spot           | Shipped public-only.                                             |
| ADR TWAP overdue (08-08)   | **Law accepted, craft not landed.**                              |

---

## Top 10 actionable agent units

Money-first. No owner parameter invention; refuse-closed or mechanism that fails tests without new product numbers where possible.

### 1. TWAP re-space + overdue spacing (Class M if mounted)

**Claim broken:** D5, D6 (ADR 2026-08-08).  
**Fix unit:** Change `tick` due-time derivation to resume/re-base per ADR; refuse resume if projected duration >2× original; return new projected end on resume; **test** “many intervals overdue → min gap ≥ sliceIntervalMs” (must fail on current engine).  
**Files:** `algo/twap-engine.ts`, `algo/types.ts`, `algo/twap-engine.test.ts`, parent store if columns needed.  
**Do not** mount job host in same PR unless 2–3 also green.

### 2. TWAP cancel atomicity (children + parent)

**Claim broken:** D8, D9.  
**Fix unit:** Cancel disposition in one transactional shape: cancel children first with durable “cancelling” parent state, or all-or-nothing; never set `cancelled` while live children uncancelled; restart rehydrate re-cancels open children for cancelled parents.  
**Test:** inject cancelChild throw → parent not active; restart hydrate → children cancelled.  
**Files:** `twap-engine.ts`, `parent-store.ts`, TradeService cancel path.

### 3. TWAP job host mount (default OFF) — only after 1+2

**Claim broken:** D10.  
**Fix unit:** Wire `tickAllAlgos` to existing job host pattern (candle/futures), `TRADE_ALGO_JOBS_ENABLED` default false; isolate per-parent errors (one bad market must not starve all).  
**Test:** enable flag in process → child appears; flag off → none.

### 4. Funding rate absolute bound (fail-closed)

**Claim broken:** C12.  
**Fix unit:** Refuse publish + settlement when `|rate|` exceeds configurable max (env, **no default invent** → refuse if unset when funding markets listed **or** hard refuse absurd rates with documented interim ceiling tied to existing integer checks). Prefer: `TRADE_FUTURES_FUNDING_MAX_ABS_RATE` required when funding market ids non-empty — boot fail if missing.  
**Test:** rate `"1000000"` → no ledger movement.  
**Files:** `internal-funding-rate.ts`, `funding-settlement.ts` / tick.

### 5. Funding period membership snapshot

**Claim broken:** C14.  
**Fix unit:** Load positions eligible for period at settle plan time with **stable membership** (opened_at ≤ period end AND still open or closed after period start — pin law to ADR amendment if needed; implement “positions open at period start” as safest money default).  
**Test:** open position between failed tick and replay → **no extra payer debit** / margin_current matches ledger.  
**Files:** `funding-settlement.ts`, position loader, `funding-margin-idempotency` / new test.

### 6. Copy fee-share reserve-then-post + atomic earnings

**Claim broken:** E3.  
**Fix unit:** Atomic claim of `cappedLeaderShare` under row lock / single SQL increment before ledger post; release on post failure; same for exposure RMW in mirror.  
**Test:** concurrent settleFeeShare at cap → sum ≤ cap on ledger balances.  
**Do not** mount public routes until green.  
**Files:** `copy-service.ts`, `follow-store.ts`, fee-share tests.

### 7. OTC mid age gate (reuse mark vocabulary)

**Claim broken:** F4.  
**Fix unit:** `OtcMidSource` returns `{ mid, asOf }` or null; refuse when age > policy; config map either forbidden in prod or stamped boot-time and immediately stale (forces empty). Prefer live chain of venue mid with existing gates.  
**Test:** asOf too old → `trade.otc_no_reference_price`.  
**Files:** `otc/mid-source.ts`, `otc-service.ts`.

### 8. Engine↔ledger scheduled reconcile caller

**Claim broken:** A10.  
**Fix unit:** Job (default OFF) builds counterpart view from `trade.orders` + hold balances, POSTs matching `/reconcile`, **writes nothing on refuse** — metrics/alert only; auto-delete only unfunded pending (engine table).  
**Test:** open+hold no engine → finding; no silent release of funded missing.  
**Files:** new `spot/engine-ledger-reconcile.ts` + job host; handoff doc update.

### 9. Margin-call transport stub + grace non-start seal

**Claim broken:** C15 incomplete.  
**Fix unit:** Port `notifyMarginCall` that must return delivered=true before any future grace field starts; until real notify, liquidation path must **not** treat margin_call as grace-expired. Document + test: undelivered → never liquidate from “grace”.  
**Files:** `liquidation-tick.ts`, `maintenance-ladder.ts` integration.

### 10. Insurance shortfall bound on bankrupt rung

**Claim broken:** C17 money half.  
**Fix unit:** Before posting insurance leg, `check` named insurance account balance; refuse / park position if underfunded (mirror profit-source bound) — no silent overdraw.  
**Test:** bankrupt plan with empty insurance → no ledger overdraw, position not falsely clean.  
**Files:** liquidation reducer path, profit/insurance account config.

---

## Proved money seals worth not reopening

1. Caller prices on futures REST
2. Dust / relative depth marks
3. Venue mark age
4. Closing-when-dark
5. Funding skip vs zero
6. Funding period name required
7. Leverage 10× check
8. Spot hold-before-submit
9. OTC caller mid removed
10. MM venue mid size/age (when venue path on)

---

## Explicit non-units (do not “fix” without owner)

- Insurance fund **target size / share of fees**
- Funding **anchor cadence** product law
- OTC max quote size / min notional numbers
- House desk on **our** book (ADR Q1–Q3)
- VWAP/POV (volume thin; ADR still out)
- Icebergs
- Cross-margin
- `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` magnitude (placeholder §8)

---

## How to re-verify

```bash
# tip tree
cd /private/tmp/sov-main-tip   # or refresh: git fetch && git checkout -f origin/main
# money suites (examples)
pnpm --filter @intafaced/svc-trade test -- src/algo/twap-engine.test.ts
pnpm --filter @intafaced/svc-trade test -- src/futures/orderable-path.test.ts
pnpm --filter @intafaced/svc-trade test -- src/copy/copy-service.test.ts
pnpm --filter @intafaced/svc-matching test
# grep seals
rg -n "dueAt = parent.startedAt" services/svc-trade/src/algo/twap-engine.ts
rg -n "tickAllAlgos" services/svc-trade/src
rg -n "KNOWN RACE" services/svc-trade/src/copy/copy-service.ts
```

**Provenance:** claims from README/ADRs/headers; code/test paths read 2026-08-09 on tip worktree. Tag: **DOC+CODE read**, not live `pnpm verify` this turn (unverified full suite).

---

## Top 5 broken promises (names only — for handoff)

1. **TWAP interval promise / re-space (ADR 08-08) unenforced**
2. **TWAP scheduler unmounted while create is live**
3. **Funding rate unbounded magnitude**
4. **Funding period membership (open-now vs period) double-charge residual**
5. **Copy fee-share earnings cap race (unmounted but coded)**

(Honourable money ops: **OTC mid no age**, **engine-ledger schedule missing**.)
