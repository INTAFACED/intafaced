# Lane stop — L13 BANK wave 8 topup · 2026-08-09

**Tip at writing:** re-derive (`git fetch && git log -1 --oneline origin/main`). Was `ce46c947` after #1526.

---

## Operator block

```
LANE: L13 BANK wave 8 topup
shipped: #1526 standing-order batch fairness + cancel mid catch-up re-check + ops kill parity (earn/loan/risk HTTP+tRPC same named codes) + FLAG_REGISTRY README honesty + resume-pending-earn listed
in flight: none on svc-bank wall
parked: earn day-boundary product law (Nitro) · fiat partner Class X · card issuer Class X · invest rates / auto-invest §8 · commercial crypto ramp allowlist · true FLAG_REGISTRY bank.* module wire (product go — registry remains NOT_ENFORCED by design until then)
Nitro must decide: earn day-boundary (proration vs min full day) · fiat · issuer · ramp pair allowlist · wire module flags · or none
SAFE TO CLOSE: yes — open bank code PRs merged; L1–L4 residual empty or named parks; Engine B chapter pass done
tip: re-derive (was ce46c947)
```

---

## A0 babysit

| Item                         | Result                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Open bank code PRs at orient | **none**                                                                                |
| Denon open files             | #1502 gate · #1494 support — **no** `svc-bank` intersect                                |
| Sealed re-verify             | #1491 job isolation · #1439 loan id/collateral/B-02 · #1442 blank ramp — not re-shipped |

---

## Shipped this wave (proof)

| PR        | Unit                                                                | Class | Notes                                     |
| --------- | ------------------------------------------------------------------- | ----- | ----------------------------------------- |
| **#1526** | Batch fairness + cancel re-check + ops kill parity + README honesty | **M** | CI green (Tests + DoD); squash `ce46c947` |

### Unit cards — #1526

**Ops kill parity**

1. **Promise:** env kill stops HTTP **and** tRPC for that job (#1271 transfers shape).
2. **Break:** `ops.accrueInterest` / `ops.accrueLoanInterest` / `ops.runRiskSweep` ran with flag off; interest/risk HTTP used different code strings than tRPC.
3. **Done bar:** flag off → 503 + `BankErrorCode`; service never called; HTTP codes = tRPC codes.
4. **Class N** (ops honesty)
5. **Paths:** `services/svc-bank/**`
6. **RED:** `router.mount.test.ts`
7. **Collision:** claim-check clear

**Poison batch fairness**

1. **Promise:** permanent mid-drive failures cannot starve healthy schedules under `TRANSFER_BATCH_SIZE`.
2. **Break:** oldest N throwers filled `LIMIT`; healthy never selected after #1491 isolation.
3. **Done bar:** failure bumps `next_run_at` to job `now`; healthy settles next pass under `limit=1`; no double-fire.
4. **Class M**
5. **Paths:** `transfer-service.ts` + tests
6. **RED:** `bank-service.test.ts` batch fairness case
7. Clear

**Cancel mid catch-up**

1. **Promise:** cancel/pause stops unclaimed firings; pending claims still finish.
2. **Break:** due select froze `active`; multi-occurrence drive claimed after cancel.
3. **Done bar:** status re-read under FOR UPDATE before new claim; `stopped` ends plan.
4. **Class M**
5. **Paths:** `transfer-service.ts` + tests
6. **RED:** mid-cancel catch-up case
7. Clear

**FLAG_REGISTRY honesty**

1. **Promise:** README kill table must not lie about module flags.
2. **Break:** claimed FLAG_REGISTRY kills while all `NOT_ENFORCED` and unread.
3. **Done bar:** README states env job flags are real stops; registry rows are names only.
4. **Class N docs**

---

## Engine A scorecard (wave 8)

| Unit                          | Result                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| A0 open bank PR merge         | Wall clear → **#1526** shipped                                                     |
| A1 job isolation residual     | **Sealed** #1491; **#1526** adds batch fairness (isolation ≠ progress under limit) |
| A1 spaces = ledger proofs     | **Sealed** (doctrine suite)                                                        |
| A1 loan residual after #1439  | **Sealed** re-verify                                                               |
| A2 independent reserve B-02   | **Sealed** #1439                                                                   |
| A2 ramp residual              | **Sealed** #1442 + fiat socket; commercial allowlist **park**                      |
| A2 standing orders residual   | Double-fire sealed; **#1526** fairness + cancel re-check                           |
| A2 ledger.history socket      | **Sealed** fail-loud #1491                                                         |
| A3 FLAG_REGISTRY bank.*       | **Honesty** #1526; wire **park** product                                           |
| A3 earn pool residual         | Recipes sealed; day-boundary **park**                                              |
| A3 Engine B full chapter pass | Below                                                                              |
| A3 Nitro-only                 | Named                                                                              |

---

## Engine B — chapter pass (tip after #1526)

| Chapter             | Verdict                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Where balance lives | **HONEST** — ledger only; schema guard                                                          |
| Loans               | **HONEST** — term-compare, dual-cover refuse, B-02 independent; mark oracle residual named park |
| Ramps               | **HONEST** halves; blank refuse; fiat socket; allowlist **park**                                |
| Earn                | **HONEST** recipes; day-boundary **park** Nitro                                                 |
| Standing orders     | **HONEST** — isolation + fairness + cancel re-check + pause/lock seals                          |
| Sockets §13         | **HONEST** — history fail-loud; fiat/issuer sockets; no invent                                  |
| Kill-switches       | **HONEST** — env jobs HTTP+tRPC same codes; FLAG_REGISTRY named-not-enforced documented         |
| Events              | **PARTIAL** — deliberate no-publish for earn/transfer subjects until events PR                  |
| Cards               | **HONEST** ledger half; live issuer **X**                                                       |
| API                 | **HONEST** — spaces/transfers/earn/loans/cards/ramps/ops                                        |

---

## Engine C — attack surface

| Attack              | State          |
| ------------------- | -------------- |
| local balance       | sealed         |
| job cascade kill    | sealed #1491   |
| batch starvation    | **#1526**      |
| cancel mid catch-up | **#1526**      |
| ops kill back door  | **#1526**      |
| loan dual-cover     | sealed         |
| ramp invent credit  | sealed refuse  |
| fake ledger.history | sealed #1491   |
| earn day invent     | **park** Nitro |

---

## Nitro-only (unchanged)

1. Earn day-boundary law (proration vs min full day)
2. Fiat partner / money-transmission (Class X)
3. Card issuer / BIN (Class X)
4. Invest rates / auto-invest §8
5. Commercial crypto ramp allowlist (product law)
6. Wire `FLAG_REGISTRY` `bank.*` as real module kills (optional product)

---

## SAFE TO CLOSE

**yes** — residual craft on `services/svc-bank/**` for wave 8 topup is empty or named park; #1526 banked; no open bank code PR; nothing uncommitted in this lane after stop merge.
