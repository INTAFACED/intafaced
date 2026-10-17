# LANE STOP — TRADE wave 7 · 2026-08-09

**Tip at writing:** `18ff9a5e fix(trade): liquidation no longer double-applies a full loss (#1349)` (re-derive).  
**Lane:** L03 trade residual honesty · promise falsification · money attack surface.  
**Mode:** AFK long cook · residual only · no Denon invent-risk product-complete engines.

Companion: [`LANE-STOP-TRADE-W6-2026-08-09.md`](./LANE-STOP-TRADE-W6-2026-08-09.md).

---

## Verdict

**SAFE TO CLOSE this wave** for exclusive-wall residual craft.

Wave 7 **merged the full open trade Class M bank** (spot clientOrderId, convert sell floor, copy fill-fee preference, futures open clientOpenId, liquidation claim-before-money) plus the W6 stop. Engine B money chapters re-verified on tip. Remaining items are parked Nitro/L6–L7 or deliberate product parks — not pad targets.

---

## Shipped

| PR        | Plain words                                                            | Class | Status     |
| --------- | ---------------------------------------------------------------------- | ----- | ---------- |
| **#1445** | Wave 6 lane stop banked                                                | N     | **merged** |
| **#1431** | Convert sell binds maxAvgPrice as engine IOC floor (M-03 sell half)    | M     | **merged** |
| **#1444** | Spot place **requires** clientOrderId — no double-hold on retry        | M     | **merged** |
| **#1386** | Copy fee-share prefers settled fill fee (module still unmounted)       | M     | **merged** |
| **#1362** | Futures `clientOpenId` — retried open no double margin lock            | M     | **merged** |
| **#1349** | Liq claim-before-money — no double full loss; partial loss keys unique | M     | **merged** |

---

## Engine A scoreboard

| Prio | Unit                         | Disposition                                               |
| ---- | ---------------------------- | --------------------------------------------------------- |
| A0   | Open trade PR merge bank     | **all six banked** (above)                                |
| A1   | place clientOrderId required | **#1444** (+ suite fix: ≤64-char test ids; REST map path) |
| A1   | convert sell floor           | **#1431**                                                 |
| A1   | copy fee-share actual fee    | **#1386** (mount still PARK deliberate)                   |
| A2   | futures open retry           | **#1362**                                                 |
| A2   | liquidation full-loss once   | **#1349**                                                 |
| A2   | public door promise-falsify  | Sealed via private-rest + router require/bind on tip      |
| A3   | futures/OTC product-complete | **PARK Denon** — not implemented                          |

---

## Engine B (promise falsification)

| Chapter               | Tip evidence (re-derive)                                                          |
| --------------------- | --------------------------------------------------------------------------------- |
| open/close margin     | spot `clientOrderId` required; futures `positionIdFor(clientOpenId)`              |
| liquidation           | `tryClaim` before ledger post; stable `liq:{positionId}`; partial unique loss ids |
| copy fee path         | `fillFeeAmount` preferred over invent notional×bps; blank §8 still refuses        |
| convert sell          | sell → `minProtectionPrice` engine floor from accepted maxAvgPrice                |
| client-id idempotency | spot + futures open paths; REST 400 when missing                                  |

---

## Parked (honest pick-up — not wave-7 pad)

1. **Funding notional freeze + claim-before-post** — Class M residual (ids not size today)
2. **ReconcileOrder cancel-as-probe** — non-destructive list before release
3. **Copy mount** — deliberate; fee path ready via #1386
4. **OTC mid max-age** — owner number
5. **TWAP principal durability** — socket
6. **Funding period cadence anchor** — product law / owner
7. **House MM-as-taker settle** — residual note in settleFill
8. **Nitro §8** — `leader_share_bps` · OTC spreads · leverage · venue keys · options D7
9. **#1351 matching cancel phantom** — L12 wall (not dual-edit)

---

## Coordination notes

- **claim-check over-lock:** `trade.mm-bot` `owner: Nitro` + `module: trade` still maps to entire `services/svc-trade` (W6 hoped `src/mm` only). Babysit/merge of open residual PRs stayed allowed; **new** craft under the wall is blocked until tracker/claim-check is narrowed.
- **Thrift:** hard window during cook — local green first; `THRIFT_ALLOW=1` only for money residual re-seals already open.
- **Denon open at start:** did not dual-edit #1472/#1463/#1461/#1457 (and closed #1471/#1467).
- **Local Postgres:** unavailable this host — money suites sealed on CI.

---

## Nitro must decide

- Copy mount go · OTC mid max-age · funding period order · clear/narrow `trade.mm-bot` claim so residual craft is not false-blocked · or **none** required for residual safety of banked seals

---

## SAFE TO CLOSE?

**Yes** for wave 7 exclusive-wall residual bank. Only parked Nitro/L6–L7 / deliberate product parks remain.

```
LANE: L03 TRADE wave 7
shipped: #1445 W6 stop · #1431 convert sell floor · #1444 place clientOrderId · #1386 copy fill fee · #1362 open clientOpenId · #1349 liq claim-first
in flight: none on trade wall
parked: funding freeze size · reconcile non-destructive · copy mount · OTC mid age · TWAP principal · funding cadence · MM-as-taker · Nitro §8 · #1351 L12 · claim-check mm-bot over-lock
Nitro must decide: none required for residual safety of banked seals
SAFE TO CLOSE: yes
tip: 18ff9a5e
```
