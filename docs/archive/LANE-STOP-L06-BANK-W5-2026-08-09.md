# Lane stop — L06 BANK wave 5 · 2026-08-09

**Tip at writing:** re-derive (`git fetch && git log -1 --oneline origin/main`). Was `c428e4b2` after #1372.

---

## Operator block

```
LANE: L06 BANK wave 5
shipped: #1277 user cannot resume card settlements · #1265 full coll sale with residual interest is not healthy · #1310 W4 stop docs · #1194 earn/loan id term-compare · #1271 transfer kill-switch on ops + offramp conflict · #1229 locked space standing order (incl post-then-lock recovery) · #1270 earn pending resume + ops table · #1372 reserve reconcile independent:false
in flight: none on svc-bank wall
parked: earn day-boundary product law (Nitro) · fiat partner Class X · card issuer Class X · auto-invest/business (law only) · true independent funded sum (needs ledger journal aggregation) · loan open collateral amount term-compare follow-up · monorepo Tests red on indexer maker-case (L09 / tracker owner shehzad002 on indexer.readmodels — bank cannot dual-write)
Nitro must decide: earn day-boundary (proration vs min full day) · fiat · issuer · or none
SAFE TO CLOSE: yes — open bank code PRs cleared; parks named with pick-up
tip: re-derive (was c428e4b2)
```

---

## Shipped this wave (proof)

| PR        | Unit                                                             | Class  | Notes                                                          |
| --------- | ---------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| **#1277** | User session cannot `ops.cardResumeSettlement`                   | N      | Merged early                                                   |
| **#1265** | Full coll sale + residual interest ≠ healthy active              | M      | Class M self-audit in body                                     |
| **#1310** | W4 stop note (prettier fixed)                                    | N docs | Compact banked state                                           |
| **#1194** | Earn/loan id reuse term-compare                                  | M-adj  | Independent adversarial **SHIP**                               |
| **#1271** | `ops.runDueTransfers` honors kill-switch; offramp named conflict | N      |                                                                |
| **#1229** | Standing order honors space lock/archive                         | M      | Adversarial **FIX FIRST** then recovery via `getTxByKey` + RED |
| **#1270** | Earn deposit post-then-die resume                                | M      | Rebased onto #1194; adversarial then SHIP shape                |
| **#1372** | `reconcileReserve` surfaces `independent: false`                 | N/P    | Stops drift=0 looking green (B-02 honesty)                     |

Sealed re-verified on tip (do not re-ship): **#1102** holds · **#1159** pause · **#1174** JIT · **#1186** ramp session FORBIDDEN.

---

## Engine A scorecard

| Unit                                 | Result                                                   |
| ------------------------------------ | -------------------------------------------------------- |
| A0 merge open bank PRs               | **Done** — wall clear                                    |
| A1 ramps residual                    | Crypto + fiat refuse + #1186 sealed; fiat partner **X**  |
| A1 locked space standing-order drain | **#1229**                                                |
| A2 earn/loan/card promise falsify    | Partial: #1194 #1270 #1265 #1277; day-boundary parked    |
| A2 spaces balance=ledger             | Existing doctrine tests; no new break found this wave    |
| A2 auto-invest/business              | **Parked** — no invent without Done bar / §8             |
| A3 idempotency                       | **#1194**                                                |
| A3 sovereign-card residual           | Custodial half done prior; no invent FX; SA half Shehzad |
| A3 README matrix                     | Prior #1267 + #1270 ops row for resumePendingEarn        |
| A3 Class M adversarial               | Posted on #1194 #1229 #1270                              |

---

## Engine B — chapter pass (summary)

| Chapter            | Verdict                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Spaces / transfers | Lock on standing order **fixed**; pause sealed prior                                       |
| Earn               | Term-compare + pending resume **fixed**; day-boundary still **product open**               |
| Loans              | False-cure **fixed**; reconcile honesty flag **fixed**; real drift still needs journal sum |
| Cards              | Session resume FORBIDDEN; holds/JIT sealed; refunds unbuilt by design                      |
| Ramps              | Session cannot credit; fiat socket refuse; partner **X**                                   |

---

## Engine C

- No local balances — doctrine tests hold.
- Holds / pause / JIT seals — not regressed.
- Ramp fail-closed — sealed.
- Monorepo **Tests** job can still red on **svc-indexer** maker casing (tip #1228 lowercases; mount test expected upper). Bank merges proceeded when other checks complete; full green seal needs L09/owner path.

---

## Next for a fresh agent

1. Earn day-boundary **only after Nitro product pick**.
2. Independent `funded` sum when ledger journal aggregation exists (or bank funding table) — flip `independent: true` + non-zero drift RED.
3. Loan open: collateral amount in term-compare (adversarial residual on #1194).
4. Do **not** implement under `services/svc-indexer` while claim-check maps it human-owned.

**SAFE TO CLOSE:** yes for wave-5 residual craft on `services/svc-bank/**`.
