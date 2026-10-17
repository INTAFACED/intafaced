# LANE STOP — TRADE wave 9 · 2026-08-09

**Tip at writing:** `ed42f91d fix(trade): closing freeze mark + no invent mid from bare markPrice (#1561)` (re-derive).  
**Lane:** L03 trade residual honesty · promise falsification · money attack surface.  
**Mode:** AFK long cook · residual only · no Denon invent-risk product-complete engines.

Companion: [`LANE-STOP-TRADE-W8-2026-08-09.md`](./LANE-STOP-TRADE-W8-2026-08-09.md).

---

## Verdict

**SAFE TO CLOSE this wave** for exclusive-wall residual craft.

Wave 9 re-verified W8 Class M seals on tip, banked market-id drift alarm (Class N), and two Class M Denon-handoff honesty seals (closing freeze settle + no invent mid from bare markPrice). Remaining items are Nitro/L6–L7 / deliberate product parks / owner carve-outs — not pad targets.

---

## Shipped

| PR        | Plain words                                                                               | Class | Status     |
| --------- | ----------------------------------------------------------------------------------------- | ----- | ---------- |
| **#1556** | Market-id set drift is an **alarm** on the A10 reconcile tick (no heal)                   | N     | **merged** |
| **#1561** | `closing` settles at freeze `accepted_mark`; bare `markPrice` cannot invent liq-grade mid | M     | **merged** |

W8 bank (re-verified on tip — code present; not re-shipped):

| PR        | Seal                                          |
| --------- | --------------------------------------------- |
| **#1523** | Funding freeze stores size/entry snapshots    |
| **#1524** | `reconcileOrder` lists the book before cancel |
| **#1525** | Futures open requires `clientOpenId`          |

W7 bank still on tip (not re-opened): **#1349** liq · **#1362** open id · **#1386** copy fee · **#1444** place clientOrderId · **#1431** convert sell floor.

---

## Engine A scoreboard

| Prio | Unit                              | Disposition                                                         |
| ---- | --------------------------------- | ------------------------------------------------------------------- |
| A0   | Open trade PR merge               | none open at start; banked #1556 + #1561                            |
| A1   | funding size freeze residual      | **re-verify PASS** (#1523 on tip)                                   |
| A1   | reconcile list-before-cancel      | **re-verify PASS** (#1524 on tip)                                   |
| A1   | futures clientOpenId residual     | **re-verify PASS** (#1525 on tip)                                   |
| A2   | copy mount residual               | **PARK deliberate** — fee path ready; product mount Nitro go        |
| A2   | reconcile release-on-miss         | **PARK owner carve-out** — handoff §4.3; agent must not pick winner |
| A2   | period tryClaim polish            | **PARK optional** — ledger keys + freeze absorb races               |
| A2   | market-id drift alarm             | **#1556**                                                           |
| A2   | closing freeze settle (Engine B)  | **#1561** (Denon handoff §§3–4)                                     |
| A2   | legacyQuote mid invent (Engine B) | **#1561** (Denon handoff §6)                                        |
| A3   | futures/OTC product-complete      | **PARK Denon**                                                      |
| A3   | Engine B chapter pass             | this stop                                                           |

---

## Engine B (promise falsification)

| Chapter               | Tip evidence (re-derive)                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| open/close margin     | spot clientOrderId required; futures clientOpenId required (#1525)               |
| liquidation           | tryClaim before ledger; no invent mid from bare markPrice (#1561)                |
| copy fee path         | fillFeeAmount preferred; blank §8 refuses; mount deliberate park                 |
| convert sell          | maxAvgPrice → minProtectionPrice sell floor                                      |
| client-id idempotency | spot + convert + futures open doors require retry keys                           |
| funding size          | freezeMembership snapshots size/entry; plan never re-reads open-now size (#1523) |
| reconcile probe       | listOrders first; cancel only when live (#1524)                                  |
| closing settle        | freeze-time `accepted_mark` exit; dark-period move not charged (#1561)           |
| market-id sets        | A10 tick `diffMarketIds` / warn only (#1556)                                     |

---

## Parked (honest pick-up — not wave-9 pad)

1. **Copy mount** — deliberate; fee path ready via #1386
2. **Reconcile open_hold_no_engine release policy** (fills consult / refuse) — owner carve-out; probe sealed #1524
3. **Period claim-before-post** (liq-style tryClaim on period) — optional L2 polish; keys + freeze absorb races
4. **OTC mid max-age** — owner number
5. **TWAP principal durability** — socket
6. **Funding period cadence anchor** — product law / owner
7. **House MM-as-taker settle** — residual note in settleFill
8. **Nitro §8** — `leader_share_bps` · OTC spreads · leverage · venue keys · options D7
9. **Denon futures residual (handoff 2026-08-09)** — deviation breaker latch · jobs-off basis walk · margin-call transport · MM seeder assertTradable (not invent-risk engines; need safe discriminator / owner numbers where noted)
10. **Shehzad #1177** — babysit only

---

## Coordination notes

- **claim-check:** clear for `services/svc-trade` vs open PRs during cook (dependabot + Shehzad #1177).
- **Denon open product PRs:** 0 at issue; did not invent product-complete engines.
- **Shehzad #1177:** babysit only — never dual-edit protocol.
- **Local Postgres:** unavailable on cook host — Class M money suites sealed on **CI Tests** for #1561.
- **Anti-pad:** did not invent Engine A units to fill a quota.

---

## Nitro must decide

- Copy mount go · OTC mid max-age · funding period cadence · reconcile release-when-fills-missing policy · or **none** required for residual safety of banked seals

---

## SAFE TO CLOSE?

**Yes** for wave 9 exclusive-wall residual bank. Only parked Nitro/L6–L7 / deliberate product parks / Denon-direction residuals remain.

```
LANE: L03 TRADE wave 9
shipped: #1556 market-id drift alarm · #1561 closing freeze settle + no invent mid · W8 #1523–#1525 re-verified
in flight: none on trade wall
parked: copy mount · reconcile release-on-miss · period tryClaim polish · OTC mid age · TWAP principal · funding cadence · MM-as-taker · Nitro §8 · Denon latch/basis/margin-call/MM-seed residual
Nitro must decide: none required for residual safety of banked seals
SAFE TO CLOSE: yes
tip: ed42f91d
```
