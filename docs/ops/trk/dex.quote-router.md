# TRK-dex.quote-router — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `dex.quote-router`  
**Title:** Live cross-venue quote — real prices or a typed refusal  
**Module / phase:** `dex` · protocol plane  
**Status on tip:** code **finished** for router logic; **not `done`** until a real venue answers in durable ops (see tracker note + `socket.dex-venue-set`)  
**Tip freeze:** `origin/main` @ `56696496`  
**Pack type:** research only — **do not invent quotes**.

---

## 1 · What “done” means (plain language)

1. `quote` returns a real route from live venues **or** a typed refusal naming dead venues.
2. No cache/fallback invented mid; age bounds enforced on read completion time.
3. Response flags (`degraded`, `singleVenue`, `venuesConfigured`) prevent “best of several” lies.
4. No `ccxt` / float path in money-adjacent parsing.
5. Durable venue set actually reachable in the env that claims production.

---

## 2 · Current code state (tip)

### 2.1 Finished code (tracker honesty)

| Piece                   | Path / fact                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Quote service           | `services/svc-dex/src/quote/`                                                      |
| Router                  | `router-quote.ts` · `router.ts`                                                    |
| Adapters                | intachain-clob · internal-book · external (config, empty default)                  |
| Custody posture         | Protocol plane, non-custodial; custody-scan clean                                  |
| Live probe (historical) | Default config → 503 both venues unreachable; with external venue → real 200 route |

### 2.2 Why not tracker `done`

| Reason                 | Detail                                                       |
| ---------------------- | ------------------------------------------------------------ |
| No durable real venue  | Socket / ops: venue set never answered in production posture |
| External default empty | Correct safety default                                       |
| Not a code hole        | Binary works when venue reachable                            |

### 2.3 Related

- `trade.ccxt-api` is **not** this — public bot API; §27 forbids ccxt in money path.
- Permissionless access ordering still screens region first.

---

## 3 · Doctrine constraints

| Law             | Implication                                |
| --------------- | ------------------------------------------ |
| No invent price | Refuse > stale/fake                        |
| No ccxt floats  | Decimal strings only                       |
| Protocol plane  | No ledger writes from dex                  |
| Socket          | `socket.dex-venue-set` residual is ops/law |

---

## 4 · DoD sketch

- [ ] Production venue config named + monitored
- [ ] Continuous probe: refuse vs quote rates
- [ ] Tracker done only with durable venue answer proof
- [ ] Client UX must surface degraded/singleVenue

---

## 5 · Open questions

1. Which first production venue (internal-book only vs external)?
2. Who owns venue credentials ops (Class X adjacent)?
3. Indexer clob read-model freshness SLOs?

---

## 6 · Estimated size

| Code residual | **~0** for router |
| Ops venue bring-up | **M** + socket |

---

## 7 · Related docs / code

- `services/svc-dex/README.md` · `src/quote/*`
- Tracker note on `dex.quote-router` (long, authoritative)
- Short twin trade: venue fabric in `svc-trade` README

---

## 8 · Explicit non-goals

- No inventing mid to make quote 200 in CI without venue.
- No ccxt dependency.
- No claiming done without venue set.

---

## 9 · Client contract (must not lie)

| Field              | Meaning                            |
| ------------------ | ---------------------------------- |
| `degraded`         | Not all configured venues answered |
| `singleVenue`      | Only one venue contributed         |
| `venuesConfigured` | What ops thought was live          |
| `unavailable` legs | Named dead venues                  |

UI that shows a single-venue quote as “best price across venues” is a product defect even if HTTP 200.

## 10 · Socket residual

`socket.dex-venue-set` (or equivalent) tracks durable venue bring-up. Closing this row is **ops + config**, not more router arithmetic.

## 11 · First PR shape (ops-facing)

| PR  | Scope                                 |
| --- | ------------------------------------- |
| 1   | Runbook: enable external venue safely |
| 2   | Probe job: 503 vs 200 rates           |
| 3   | Tracker done criteria evidence pack   |
