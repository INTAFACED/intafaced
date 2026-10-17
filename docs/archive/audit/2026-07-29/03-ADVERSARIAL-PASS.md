# Adversarial pass honesty — 2026-07-29 wave-1

**Claim tags:** `[VERIFIED 2026-07-29]` from findings + PR #80 · `[HONESTY]` method limits named so V2 does not pretend wave-1 was best-in-class

---

## What was confirmed (re-read by orchestrator)

| Finding                             | Verdict                   | Evidence class                           |
| ----------------------------------- | ------------------------- | ---------------------------------------- |
| L6-1 protocol never mounted `/trpc` | Confirmed → **FIXED**     | Code + edge/web pointing at dead door    |
| L2-2 awardXp public mint            | Confirmed → **FIXED**     | Router + identity tests 84               |
| L2-1 pay mutation IDOR              | Confirmed → **FIXED**     | Router ownership + pay tests 221         |
| L2-3 unauth internal routes         | Confirmed → **FIXED**     | HMAC on identity/token/p2p               |
| L5 dex wrong ports                  | Confirmed → **FIXED**     | compose / env                            |
| L1/L9 brand+format red              | Confirmed → **FIXED**     | brand-scan clean; vendor prettier ignore |
| L3-1/2/3 money crash windows        | Confirmed → **queued P1** | Not fixed this PR (correct scope)        |
| L1 dual-book stake/earn             | Confirmed → **queued P2** | Structural                               |

---

## What wave-1 did **not** fully do (upgrade targets for V2)

| Method gap (from plan meta-audit) | Wave-1 reality                                                             | V2 requirement                                                      |
| --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **G1 Cross-family critic**        | Same-program adversarial re-check; not proven as separate model family     | Fresh-context + read-only + different family on residual P1         |
| **G2 L0 machine expansion**       | Used brand/custody/verify; did not grow new doctrine scanners              | Add greps/rules for money-as-number, bare posts, etc. where missing |
| **G3 Coverage metrics**           | Strong qualitative layers; incomplete public-procedure _counts_ vs checked | Census: procedures / routes / money journeys with N/M               |
| **G4 Property / crash matrix**    | Crash windows named; no property-test invariants yet                       | fast-check or equivalent on ledger/hold invariants for P1 fixes     |
| **G5 False-done cheat scan**      | Self-audit + verify green; no structural cheat detectors on diff           | Run cheat detectors (or home checks) on every V2 fix PR             |
| **G7 Threat model page**          | Implicit                                                                   | One-page attacker × goal before residual money fixes                |
| **03-ADVERSARIAL-PASS**           | Missing until this file                                                    | This file is the honesty log                                        |

**Not a failure of wave-1 purpose** — wave-1 found and fixed real open doors. It is incomplete as _proof diversity_. V2 closes that.

---

## Rejected / non-findings (so they do not re-open as fear)

- Production services inventing balances outside recipes — **not found**
- Protocol plane ledger write custody bleed — **custody-scan clean**
- Historical #50/#55/#62/#75 regressions re-broken — **still fixed**
- Vendor as current custody path — **quarantined**; not co-running as books

---

## Machine proof cited on fix branch (PR #80)

- `pnpm verify` claimed green on branch
- brand-scan clean · custody-scan clean
- identity 84 · pay 221 · typecheck on touched services

Re-check before merge if CI still finishing: open PR #80 checks.
