# Lane stop — L12 BANK wave 9 topup · 2026-08-09

**Tip at writing:** re-derive (`git fetch && git log -1 --oneline origin/main`). Was `e0126fbb` at orient (paste lead matches tip).

**Provenance:** machine re-derive on tip — not relay of W8 stop alone. Local main checkout may lag; this wave worked in worktree on `origin/main`.

---

## Operator block

```
LANE: L12 BANK wave 9 topup
shipped: none (W8 #1526 seals re-verified on tip; no L1–L4 residual craft)
in flight: none on svc-bank wall
parked: earn day-boundary product law (Nitro) · fiat partner Class X · card issuer Class X · invest rates / auto-invest §8 · commercial crypto ramp allowlist · true FLAG_REGISTRY bank.* module wire (product go — registry remains NOT_ENFORCED by design)
Nitro must decide: earn day-boundary (proration vs min full day) · fiat · issuer · ramp pair allowlist · wire module flags · or none
SAFE TO CLOSE: yes — open bank code PRs none; L1–L4 residual empty or named parks; Engine B chapter pass done; no pad
tip: re-derive (was e0126fbb)
```

---

## A0 babysit

| Item                            | Result                                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| Tip                             | `e0126fbb` at orient (matches paste lead)                               |
| Open bank code PRs              | **none** (open: #1177 Shehzad protocol babysit only · dependabot maven) |
| claim-check `services/svc-bank` | **clear** of open PR path intersect                                     |
| Denon invent-risk engines       | not taken (futures/OTC/PSP full product fenced)                         |
| Sealed re-verify (static)       | #1526 on tip as `ce46c947` ancestor — see below                         |

---

## Sealed re-verify (W8 #1526 — do not re-ship)

**Merge:** #1526 squash `ce46c947` · title: standing-order batch fairness + ops kill parity · **on tip** (`git merge-base --is-ancestor ce46c947 origin/main`).

| Seal                  | Tip path proof                                                                                          | Test / surface                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Batch fairness        | `transfer-service.ts` `deprioritiseAfterFailure` bumps `next_run_at` to job `now` after mid-drive throw | `bank-service.test.ts` — _permanently failing schedules cannot starve healthy ones under the batch limit_                                                                      |
| Cancel mid catch-up   | drive re-reads schedule status under FOR UPDATE before new claim; `stopped` ends plan                   | `bank-service.test.ts` — _cancel during a multi-occurrence catch-up stops unclaimed firings_                                                                                   |
| Ops kill parity       | HTTP + tRPC: `INTEREST_ACCRUAL` / `LOAN_ACCRUAL` / `LOAN_RISK_SWEEP` + transfers                        | codes `bank.interest_accrual_disabled` · `bank.loan_accrual_disabled` · `bank.loan_risk_sweep_disabled` · `bank.transfers_disabled` — `router.mount.test.ts` + `index.ts` jobs |
| FLAG_REGISTRY honesty | README kill table: env jobs are real stops; registry rows **Named only / NOT_ENFORCED**                 | `README.md` Kill-switches; no live module-kill lie                                                                                                                             |

**Earlier seals still on tip (not re-shipped):** #1491 job isolation · #1439 loan collateral/B-02 · #1442 blank ramp · #1229 lock on standing debit · #1271 transfers kill · #1270 earn resume · spaces=ledger doctrine suite · history fail-loud #1491 · dual-cover shortfall repay refuse (`hasOpenShortfall` → liquidating) · residual-interest non-cure · cards ledger half + issuer refuse · fiat ramp socket.

**Local re-run note:** fresh worktree needed package `tsc` dist before vitest collects; seal presence verified by tip file contents + merge ancestry. CI already greened #1526.

---

## Engine A scorecard (wave 9)

| Unit                             | Result                                                                     |
| -------------------------------- | -------------------------------------------------------------------------- |
| A0 open bank PR merge            | Wall clear — nothing to merge                                              |
| A1 standing-order batch residual | **Sealed** #1526 — re-verified on tip                                      |
| A1 ops kill parity residual      | **Sealed** #1526 — HTTP+tRPC same named codes                              |
| A1 spaces = ledger proofs        | **Sealed** doctrine suite                                                  |
| A2 loan residual                 | **Sealed** #1439 + dual-cover refuse + residual-interest non-cure          |
| A2 ramps crypto residual         | **Sealed** #1442 + fiat socket; allowlist **park**                         |
| A2 cards residual                | **Sealed** ledger half; live issuer **X**                                  |
| A2 FLAG_REGISTRY bank residual   | **Honesty** #1526; wire **park** product                                   |
| A3 ledger.history socket         | **Sealed** fail-loud; real procedure = contracts+ledger (§1) not bank-only |
| A3 Engine B full pass            | Below                                                                      |
| A3 Nitro-only / greenfield       | Named parks — no invent                                                    |

**No agent craft unit cleared the unit card.** Residual-empty for L1–L4 on `services/svc-bank/**`.

---

## Engine B — chapter pass (tip after #1526, re-run W9)

| Chapter             | Verdict                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Where balance lives | **HONEST** — ledger only; schema money-column guard                                                      |
| Loans               | **HONEST** — term-compare, dual-cover refuse, B-02 independent; mark quality refuse named                |
| Ramps               | **HONEST** crypto half + blank refuse + fiat socket; commercial allowlist **park**                       |
| Cards               | **HONEST** ledger half; live rail **X** / `socket.live-issuer`                                           |
| Earn                | **HONEST** recipes + isolation; day-boundary **park** Nitro                                              |
| Standing orders     | **HONEST** — isolation + fairness + cancel re-check + pause/lock seals                                   |
| Sockets §13         | **HONEST** — history fail-loud; fiat/issuer sockets; no invent                                           |
| Kill-switches       | **HONEST** — env jobs HTTP+tRPC; FLAG_REGISTRY named-not-enforced documented                             |
| Events              | **PARTIAL** — margin_call publishes; planned transfer/earn subjects need events PR first (L15 wall / §1) |
| API                 | **HONEST** — spaces/transfers/earn/loans/cards/ramps/ops                                                 |

---

## Engine C — attack surface (W9)

| Attack              | State                                   |
| ------------------- | --------------------------------------- |
| local balance       | sealed                                  |
| job cascade kill    | sealed #1491                            |
| batch starvation    | sealed #1526                            |
| cancel mid catch-up | sealed #1526                            |
| ops kill back door  | sealed #1526                            |
| loan dual-cover     | sealed (code + residual-interest tests) |
| ramp invent credit  | sealed refuse                           |
| fake ledger.history | sealed #1491                            |
| earn day invent     | **park** Nitro                          |

Optional thin suite note (not a break, not craft): dedicated RED for “repay refused while open shortfall” — path exists in `loan-service.repay`; skip pad.

---

## Nitro-only (unchanged)

1. Earn day-boundary law (proration vs min full day)
2. Fiat partner / money-transmission (Class X)
3. Card issuer / BIN (Class X)
4. Invest rates / auto-invest §8
5. Commercial crypto ramp allowlist (product law)
6. Wire `FLAG_REGISTRY` `bank.*` as real module kills (optional product)

---

## Unit card — this wave (stop only)

1. **Promise:** residual-empty honesty when only Nitro parks remain (paste L12 substance gate)
2. **Break:** none on tip after #1526 re-verify
3. **Done bar:** this stop note banked; no invented code; SAFE TO CLOSE
4. **Class N** (docs)
5. **Paths:** `docs/LANE-STOP-L12-BANK-W9-2026-08-09.md` only
6. **RED first:** N/A (no code residual)
7. **Collision:** claim-check clear; no open bank PRs

---

## SAFE TO CLOSE

**yes** — residual craft on `services/svc-bank/**` for wave 9 topup is empty or named park; #1526 seals hold on tip; no open bank code PR; nothing uncommitted after this stop merges; **no pad**.
