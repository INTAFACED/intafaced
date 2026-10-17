# Audit baseline — 2026-07-29

**Claim tags:** `[VERIFIED 2026-07-29]` this session  
**Program:** [`docs/FULL-AUDIT-PROGRAM-2026-07-29.md`](../../FULL-AUDIT-PROGRAM-2026-07-29.md)  
**Worktree:** `.worktrees/chore-full-audit-2026-07-29`  
**Branch:** `chore/full-audit-2026-07-29` (tracks `origin/main` at freeze)

---

## Frozen tip

| Field                            | Value                                                             |
| -------------------------------- | ----------------------------------------------------------------- |
| **BASELINE_SHA**                 | `a19e33725d57699eb29f415663eb171ed1efb693`                        |
| **Tip subject**                  | `feat(vendor): third-party exchange platform, wired to run (#73)` |
| **UTC freeze**                   | 2026-07-29T03:54:27Z                                              |
| **Open PRs**                     | `0`                                                               |
| **Local main (parent checkout)** | Stale / not used for this program                                 |

---

## Machine truth (gates)

| Check                            | Result                         | Notes                                                                                         |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| GitHub CI latest on `main` (#73) | **failure**                    | [run 30382040779](https://github.com/Phantom-X-007/intafaced/actions/runs/30382040779)        |
| CI · Tests job                   | **success**                    | Same run                                                                                      |
| CI · Typecheck & build           | **failure** on `format:check`  | Prettier issues under `vendor/upstream-exchange/`                                             |
| CI · Doctrine gates              | **failure** on brand scan §0.7 | Vendor identity strings (docs + wiring)                                                       |
| CI · DoD                         | **skipped**                    | After doctrine fail                                                                           |
| Local `pnpm scan:brand`          | **fail**                       | Hits include `docs/adr/2026-07-28-upstream-exchange-integration.md` and related vendor naming |
| Local `pnpm scan:custody`        | **pass**                       | 50 files / 3 Protocol Plane services                                                          |
| Local `pnpm tracker:check`       | **pass**                       | TRACKER.md + README in sync with features.mjs                                                 |
| Local `pnpm format:check`        | **fail**                       | 43 files — almost entirely `vendor/upstream-exchange/**`                                      |
| Local `pnpm verify`              | **running / see log**          | `/tmp/full-audit-verify.log` or session terminal log                                          |

---

## What this baseline implies (plain)

1. **Product code tests were green** on the last main CI run; the red is **vendor blob + brand/format policy**, not a silent test blackout.
2. **Main is still not “clean to trust as process”** — doctrine brand gate is red after the vendor merge.
3. Prior same-day hotfixes (#72–#79) show deploy/auth thrash; regression layers still required.
4. Orientation docs outside this worktree (parent `docs/START-HERE.md` on stale main) **must not** be treated as floor until Phase C updates from this SHA.

---

## How to re-check

```bash
cd .worktrees/chore-full-audit-2026-07-29
git rev-parse HEAD   # must be a19e337… unless program re-baselined
pnpm scan:brand && pnpm scan:custody && pnpm tracker:check
pnpm format:check
pnpm verify
```
