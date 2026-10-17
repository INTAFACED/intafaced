# Lane stop — L13 BANK wave 7 topup · 2026-08-09

**Tip at writing:** re-derive (`git fetch && git log -1 --oneline origin/main`). Was `0e2f7382` after #1491.

---

## Operator block

```
LANE: L13 BANK wave 7 topup
shipped: #1491 one bad job no longer stops every standing order / earn pool / loan accrual pass · ledger.history fail-loud RED
in flight: none on svc-bank wall
parked: earn day-boundary product law (Nitro) · fiat partner Class X · card issuer Class X · invest rates / auto-invest §8 · commercial crypto ramp allowlist (shape refuse only) · FLAG_REGISTRY bank.* module kills not wired (env job flags are)
Nitro must decide: earn day-boundary (proration vs min full day) · fiat · issuer · ramp pair allowlist · or none
SAFE TO CLOSE: yes — open bank code PRs merged; L1–L4 residual empty or named parks
tip: re-derive
```

---

## A0 babysit

| Item                         | Result                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Open bank code PRs at orient | **none** (claim-check clear)                                                     |
| Denon open files             | docs/venue only — **no** `svc-bank` intersect                                    |
| Sealed re-verify             | #1439 loan id/collateral/B-02 · #1442 blank ramp refuse — on tip, not re-shipped |

---

## Shipped this wave (proof)

| PR        | Unit                               | Class | Notes                                  |
| --------- | ---------------------------------- | ----- | -------------------------------------- |
| **#1491** | Job isolation + history socket RED | **M** | CI green then squash-merged `0e2f7382` |

### Unit card — #1491

1. **Promise:** one underfunded pool / one mid-drive throw must not stop the platform (audit B-3/B-4 class; risk-sweep already isolates per loan).
2. **Break:** `runDueTransfers` / `earn.accrueAll` / `loans.accrueAll` rethrew out of the loop.
3. **Done bar:** failures listed; other schedules/pools continue; single-target ops still loud; history 404/500 never empty spend.
4. **Class M**
5. **Paths:** `services/svc-bank/**` only
6. **RED first:** isolation cases in `bank-service.test.ts` + `ledger-history.socket.test.ts`
7. **Collision:** claim-check clear; Denon no bank files

---

## Engine A scorecard (wave 7)

| Unit                           | Result                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| A0 open bank PR merge          | Wall clear → #1491 shipped                                                               |
| A1 spaces = ledger proofs      | **Sealed** (doctrine suite)                                                              |
| A1 loan residual after #1439   | **Sealed** re-verify (id/collateral/borrower mismatch + B-02 independent funding)        |
| A1 independent reserve funding | **Sealed** #1439                                                                         |
| A2 ramp residual honesty       | **Sealed** crypto half + blank refuse #1442 + fiat socket; commercial allowlist **park** |
| A2 standing orders residual    | Double-fire sealed; **#1491** isolation; lock drain sealed W6                            |
| A2 ledger.history socket       | **#1491** fail-loud RED; real procedure still contracts+ledger (§1)                      |
| A2 earn pool residual          | Recipes sealed; **#1491** underfunded isolation; day-boundary **park**                   |
| A3 cards residual              | Ledger half sealed; live issuer **X**                                                    |
| A3 bank↔token                  | Purpose pots + native refuse sealed                                                      |
| A3 Engine B chapter pass       | Below                                                                                    |
| A3 Nitro-only parks            | Named                                                                                    |

---

## Engine B — chapter pass (tip after #1491)

| Chapter                     | Verdict                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where balance lives         | **HONEST** — ledger only; schema guard                                                                                                                             |
| API                         | **HONEST** — spaces/transfers/earn/loans/cards/ramps/ops                                                                                                           |
| Events                      | **PARTIAL** — deliberate no-publish for earn/transfer subjects; margin-call publisher exists on tip                                                                |
| Ledger                      | **HONEST** — recipes + purposed pots                                                                                                                               |
| Coordination with svc-token | **HONEST** — purpose keys + native refuse                                                                                                                          |
| Ordering                    | **HONEST** — claim/post; isolation on jobs                                                                                                                         |
| DB constraints              | **HONEST** — double-fire + money CKs                                                                                                                               |
| Kill-switches               | **PARTIAL** — env job flags wired (HTTP + tRPC ops transfers); `FLAG_REGISTRY` `bank.*` **NOT_ENFORCED** (README claims module flags — park honesty or wire later) |
| Sockets §13                 | **HONEST** — fiat/issuer sockets; history fail-loud; no invent                                                                                                     |
| Loans / cards / ramps       | **HONEST** halves; Class X rails parked                                                                                                                            |

---

## Engine C — attack surface (this cook)

| Attack                | State                                                 |
| --------------------- | ----------------------------------------------------- |
| local balance         | sealed                                                |
| hold leak (standing)  | N/A (no hold on SO); card holds ledger recipes        |
| ramp invent credit    | sealed refuse                                         |
| loan dual-cover       | code refuse + residual-interest non-cure tests on tip |
| double standing order | sealed                                                |
| fake ledger.history   | **#1491**                                             |
| earn day invent       | **park** Nitro                                        |
| one bad job stops all | **#1491** fixed                                       |

---

## Nitro-only (unchanged)

1. Earn day-boundary law (proration vs min full day)
2. Fiat partner / money-transmission (Class X)
3. Card issuer / BIN (Class X)
4. Invest rates / auto-invest §8
5. Commercial crypto ramp allowlist (product law)

---

## SAFE TO CLOSE

**yes** — residual craft on `services/svc-bank/**` for wave 7 topup is empty or named park; #1491 banked; no open bank code PR; nothing uncommitted in this lane after stop merge.
