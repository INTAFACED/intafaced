# LANE STOP — TRADE wave 8 · 2026-08-09

**Tip at writing:** `bf6fa4c2 fix(trade): futures open requires a client id (no double margin on retry) (#1525)` (re-derive).  
**Lane:** L03 trade residual honesty · promise falsification · money attack surface.  
**Mode:** AFK long cook · residual only · no Denon invent-risk product-complete engines.

Companion: [`LANE-STOP-TRADE-W7-2026-08-09.md`](./LANE-STOP-TRADE-W7-2026-08-09.md).

---

## Verdict

**SAFE TO CLOSE this wave** for exclusive-wall residual craft.

Wave 8 banked three Class M honesty seals (funding size freeze, reconcile list-before-cancel, futures required clientOpenId). W7 seals re-verified on tip. Remaining items are Nitro/L6–L7 / deliberate product parks — not pad targets.

---

## Shipped

| PR        | Plain words                                                               | Class | Status     |
| --------- | ------------------------------------------------------------------------- | ----- | ---------- |
| **#1523** | Funding freeze stores **size/entry snapshots**, not only position ids     | M     | **merged** |
| **#1524** | `reconcileOrder` **lists** the book before cancel (no cancel-as-probe)    | M     | **merged** |
| **#1525** | Futures open **requires** `clientOpenId` — no double margin lock on retry | M     | **merged** |

W7 bank (already on tip at wave start; re-verified): **#1349** liq · **#1362** open id · **#1386** copy fee · **#1444** place clientOrderId · **#1431** convert sell floor. Matching **#1351** merged on L01 wall (not dual-edit).

---

## Engine A scoreboard

| Prio | Unit                          | Disposition                                      |
| ---- | ----------------------------- | ------------------------------------------------ |
| A0   | Open trade PR merge bank      | none open at start; banked W8 three above        |
| A1   | liquidation double residual   | **re-verify PASS** (W7 #1349)                    |
| A1   | open/place client-id residual | **#1525** futures require; spot #1444 held       |
| A1   | copy fee-share residual       | **re-verify PASS** (W7 #1386; mount still park)  |
| A2   | convert sell floor residual   | **re-verify PASS** (W7 #1431)                    |
| A2   | funding freeze size honesty   | **#1523**                                        |
| A2   | reconcile non-destructive     | **#1524** (probe half; release policy unchanged) |
| A3   | futures/OTC product-complete  | **PARK Denon**                                   |

---

## Engine B (promise falsification)

| Chapter               | Tip evidence (re-derive)                                                   |
| --------------------- | -------------------------------------------------------------------------- |
| open/close margin     | spot clientOrderId required; futures clientOpenId **required** (#1525)     |
| liquidation           | tryClaim before ledger; stable `liq:{positionId}`; partial unique loss ids |
| copy fee path         | fillFeeAmount preferred; blank §8 still refuses; mount deliberate park     |
| convert sell          | maxAvgPrice → minProtectionPrice sell floor                                |
| client-id idempotency | spot + convert + futures open doors all require retry keys                 |
| funding size          | freezeMembership snapshots size/entry; plan never re-reads open-now size   |
| reconcile probe       | listOrders first; cancel only when live repair                             |

---

## Parked (honest pick-up — not wave-8 pad)

1. **Copy mount** — deliberate; fee path ready via #1386
2. **Reconcile open_hold_no_engine release policy** (fills consult / refuse) — owner carve-out; probe sealed #1524
3. **Period claim-before-post** (liq-style tryClaim on period) — ledger keys + freeze absorb races; optional L2 polish
4. **OTC mid max-age** — owner number
5. **TWAP principal durability** — socket
6. **Funding period cadence anchor** — product law / owner
7. **House MM-as-taker settle** — residual note in settleFill
8. **Nitro §8** — `leader_share_bps` · OTC spreads · leverage · venue keys · options D7
9. **Market-id drift alarm** on engine-ledger job — L3 ops polish

---

## Coordination notes

- **claim-check:** tip clear for `services/svc-trade` (mm-bot released; no whole-service Nitro lock).
- **Denon open:** did not dual-edit #1502 / #1494.
- **Shehzad #1177:** babysit only.
- **Local Postgres:** money PG suites sealed on CI when host DB down.

---

## Nitro must decide

- Copy mount go · OTC mid max-age · funding period cadence · reconcile release-when-fills-missing policy · or **none** required for residual safety of banked seals

---

## SAFE TO CLOSE?

**Yes** for wave 8 exclusive-wall residual bank. Only parked Nitro/L6–L7 / deliberate product parks remain.

```
LANE: L03 TRADE wave 8
shipped: #1523 funding size freeze · #1524 reconcile list-before-cancel · #1525 futures clientOpenId required
in flight: none on trade wall
parked: copy mount · reconcile release-on-miss policy · period tryClaim polish · OTC mid age · TWAP principal · funding cadence · MM-as-taker · Nitro §8 · market-id drift alarm
Nitro must decide: none required for residual safety of banked seals
SAFE TO CLOSE: yes
tip: bf6fa4c2
```
