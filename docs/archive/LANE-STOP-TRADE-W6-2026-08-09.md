# LANE STOP — TRADE wave 6 · 2026-08-09

**Tip at writing:** `5081ff87 docs(trade): wave 5 lane stop — residual sealed (#1395)` (re-derive).  
**Lane:** L05 trade residual · promise falsification · money attack surface.  
**Mode:** AFK long cook · residual only.

Companion: [`LANE-STOP-TRADE-W5-2026-08-09.md`](./LANE-STOP-TRADE-W5-2026-08-09.md).

---

## Verdict

**SAFE TO CLOSE this wave** for exclusive-wall residual craft.

Wave 5 residual PRs still babysit (monorepo Tests red on sibling walls — re-derive). Wave 6 **merged the W5 stop**, opened **two new Class M seals** (convert sell floor + required clientOrderId), and re-ran Engine B (most W4/W5 money seals already on tip).

---

## Shipped / in flight

| PR        | Plain words                                                             | Class | Status at stop                                      |
| --------- | ----------------------------------------------------------------------- | ----- | --------------------------------------------------- |
| **#1395** | Wave 5 lane stop banked (Prettier fixed)                                | N     | **merged**                                          |
| **#1349** | Liq claim-before-money — no double full loss                            | M     | open · MERGE_OK · CI Tests red on **sibling** walls |
| **#1351** | Matching cancel never invents a market that never traded                | N     | open · MERGE_OK · same tip Tests block              |
| **#1362** | `clientOpenId` — retried futures open no double margin lock             | M     | open · MERGE_OK                                     |
| **#1386** | Copy fee-share prefers settled fill fee (still unmounted)               | M     | open · MERGE_OK                                     |
| **#1431** | Convert **sell** binds maxAvgPrice as engine IOC floor (M-03 sell half) | M     | open · W6 new                                       |
| **#1444** | Spot place **requires** clientOrderId — no double-hold on retry         | M     | open · W6 new                                       |

---

## Engine A scoreboard

| Prio | Unit                    | Disposition                                          |
| ---- | ----------------------- | ---------------------------------------------------- |
| A0   | Merge open trade / stop | **#1395** merged; code PRs await tip Tests green     |
| A1   | Copy fee residual       | **#1386** (mount still PARK deliberate)              |
| A1   | Convert sell floor      | **#1431**                                            |
| A1   | Spot clientOrderId      | **#1444**                                            |
| A1   | OTC / MM / venue dark   | Sealed prior waves (size/age mid; no invent)         |
| A2   | Algo OFF / ccxt 501     | Sealed; jobs default OFF                             |
| A3   | Matching cancel         | **#1351**                                            |
| A3   | Liq claim / open id     | **#1349** · **#1362**                                |
| A3   | Engine B re-run         | New breaks only → **#1431** · **#1444**; rest parked |

---

## Parked (honest pick-up)

1. **Funding notional freeze + claim-before-post** — membership freezes ids not size; period markSettled after posts (Class M residual)
2. **ReconcileOrder cancel-as-probe** — non-destructive list before release (Class M operator path)
3. **Copy mount** — deliberate; fee path ready via #1386
4. **OTC mid max-age** — owner number
5. **TWAP principal durability** — socket
6. **Funding period cadence anchor** — product law / owner
7. **House MM-as-taker settle** — residual note in settleFill
8. **Nitro §8** — leader_share_bps · OTC spreads · leverage · venue keys · options D7

---

## Nitro must decide

- Copy mount go · OTC mid max-age · funding period order · or **none** required for residual safety

---

## Machine

- Worktrees: `w6-trade-residual-a/b`, convert-sell-floor, spot-client-order-id
- Local Postgres unavailable on this host — money suites CI seal (expected skips)
- Claim-check: `services/svc-trade` clear on tip (mm-bot narrowed to `src/mm`)

---

## SAFE TO CLOSE?

**Yes** for wave 6 residual scope. Babysit open trade Class M PRs to green when monorepo Tests clear.

```
LANE: L05 TRADE wave 6
shipped: #1395 W5 stop
in flight: #1349 liq claim · #1351 matching cancel · #1362 open clientOpenId · #1386 copy fill fee · #1431 convert sell floor · #1444 place clientOrderId required
parked: funding freeze size · reconcile non-destructive · copy mount · OTC mid age · TWAP principal · funding cadence · MM-as-taker · Nitro §8
Nitro must decide: none required for residual safety
SAFE TO CLOSE: yes
tip: 5081ff87
```
