# LANE STOP — TRADE wave 5 · 2026-08-09

**Tip at writing:** `09e54106 fix(bank): a locked space no longer drains on a standing order (#1229)` (re-derive).  
**Lane:** L05 trade residual · promise falsification · money attack surface.  
**Mode:** AFK long cook · residual only.

Companion: [`LANE-STOP-TRADE-W4-2026-08-09.md`](./LANE-STOP-TRADE-W4-2026-08-09.md).

---

## Verdict

**SAFE TO CLOSE this wave** for exclusive-wall residual craft.

Wave 4 seals held. Wave 5 opened **four residual PRs** (liq claim, matching cancel phantom, open client-idempotency, copy fee-from-fill) + merged W4 stop. Local unit suites green. **Monorepo CI Tests job is red on unrelated pay fixture** (`0xg4finish` / #1314 class) — not on matching or trade unit suites.

---

## Shipped / in flight

| PR        | Plain words                                                           | Class | Status at stop                                                                |
| --------- | --------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| **#1288** | W4 stop note banked                                                   | N     | **merged**                                                                    |
| **#1349** | Liq claim-before-money + stable id per position (no double full loss) | M     | open · local 33+ futures tests green                                          |
| **#1351** | Cancel never invents a market that never traded                       | N     | open · matching 131 tests green; CI Tests red on **pay** fixture (other wall) |
| **#1362** | `clientOpenId` — retried futures open no double margin lock           | M     | open · ids + REST tests green                                                 |
| **#1386** | Copy fee-share prefers settled fill fee (still unmounted)             | M     | open · fee-share 8 tests green                                                |

---

## Engine A scoreboard

| Prio | Unit                              | Disposition                                             |
| ---- | --------------------------------- | ------------------------------------------------------- |
| A0   | Open trade / stop                 | **#1288** + W5 PRs above                                |
| A1   | copy mount                        | **PARK** — R3 fee invent sealed #1386; routes unmounted |
| A1   | OTC mid age                       | **PARK owner**                                          |
| A1   | MM / venue                        | Sealed dark/size paths; no new hole                     |
| A2   | algo OFF / ccxt 501 / forex rails | Sealed prior waves                                      |
| A3   | matching                          | **#1351**                                               |
| A3   | concurrent liq                    | **#1349**                                               |
| A3   | open client-id                    | **#1362**                                               |
| A3   | margin-call invent                | Sealed; no D3 invent                                    |

---

## Parked (honest pick-up)

1. Copy **mount** (routes) — deliberate; fee path ready for fillFeeAmount
2. OTC mid max-age — owner number
3. TWAP principal durability — socket
4. Funding block-next unsettled period — product law
5. Sequenced venue book age-on-poll
6. Nitro §8 / leverage product / venue keys / options D7

---

## Nitro must decide

- Copy mount go · OTC max-age · funding period order · or **none**

---

## SAFE TO CLOSE?

**Yes** for wave 5 residual scope. Babysit #1349/#1351/#1362/#1386 to green CI once pay fixture (sibling) clears tip.

```
LANE: L05 TRADE wave 5
shipped: #1288 W4 stop
in flight: #1349 liq claim · #1351 matching cancel · #1362 open clientOpenId · #1386 copy fill fee
parked: copy mount · OTC mid age · TWAP principal · funding period order · sequenced book · Nitro §8
Nitro must decide: none required for residual safety
SAFE TO CLOSE: yes
tip: 09e54106
```
