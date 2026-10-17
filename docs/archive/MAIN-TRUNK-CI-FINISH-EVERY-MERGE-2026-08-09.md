# Main trunk CI — finish every merge (2026-08-09)

**Status:** SHIPPING · Nitro + Denon greenlit · Class N law/CI  
**Finish type:** **F-ALIGN** ([`ops/FINISH-ONTOLOGY.md`](ops/FINISH-ONTOLOGY.md))  
**Not thrift.** Public repo Actions free — this is trunk honesty under swarm velocity.

---

## 1 · Problem (measured)

| Fact                                                                            | Evidence                     |
| ------------------------------------------------------------------------------- | ---------------------------- |
| Only `ci.yml` runs on `push: main`                                              | Workflow audit 2026-08-09    |
| `cancel-in-progress: true` cancelled superseding main runs                      | `ci.yml` pre-change          |
| Burst day: ~95% main CI **cancelled**                                           | `gh run list --branch main`  |
| #1466 main CI **cancelled** → brand-scan never gated tip → fleet freeze → #1471 | GitHub PR/run list           |
| “Always deployable + all-hands on red” amplified thrash                         | `CONTRIBUTING.md` pre-change |

**Not the problem:** agent cognitive depth, spawn width, product ships, Actions spend (free).

---

## 2 · What we ship (this change)

| #   | Change                                                                                      | Speed impact                                               |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `ci.yml`: `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`                      | **None** on agents. More finished main runs (free).        |
| 2   | Heal law: one `main-heal` lane; no product merges on red tip; path-disjoint craft continues | **More** product progress during red than all-hands freeze |
| 3   | Docs: CONTRIBUTING · AGENTS · SWARM-MANDATE · thrift retirement note · label text           | Orientation only                                           |
| 4   | Required branch protection                                                                  | **Residual Class X** — not this PR                         |

---

## 3 · Finished means (peace-of-mind bar)

| Check | Pass                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1    | `ci.yml` expression is exactly main-exempt cancel (not global false, not still true)                                                                              |
| F2    | CONTRIBUTING §1 has one-heal + no product merge on red + trunk CI finishes                                                                                        |
| F3    | SWARM-MANDATE machine table names both rows                                                                                                                       |
| F4    | AGENTS CI habits + Telegram rule not “page Nitro every red”                                                                                                       |
| F5    | PR merged to main (or open with green checks)                                                                                                                     |
| F6    | **Post-merge proof:** after ≥2 rapid merges, ≥2 main CI runs for those SHAs reach `success` or `failure` (not cancelled solely because a newer main push arrived) |

**This PR alone cannot prove F6** until after merge under live swarm. F6 is the first AFK observation task after land.

**PASS-WITH-RESIDUALS if:** F1–F5 green, F6 deferred with owner **swarm** and named next check.

---

## 4 · E-box stress test (review / audit)

| #   | Scenario                                              | Expected                                                                                  | Risk if wrong                                       |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| E1  | 20 merges to main in 10 minutes                       | Up to 20 concurrent main CI runs; **none** cancelled by the next main push                | Back to ~95% cancel; false green confidence         |
| E2  | Agent force-pushes same PR three times                | Only latest PR run matters; prior **cancelled**                                           | Runner pile-up on one PR (cost free; noise only)    |
| E3  | Main tip red on doctrine                              | One `main-heal` claim + one fix PR; others craft path-disjoint; **no product merge**      | Competing heal PRs or more red on tip               |
| E4  | Main tip red; agent merges “unrelated” product anyway | Law forbids; no server block until Class X required checks                                | Residual: social enforcement only                   |
| E5  | Docs-only PR                                          | docs-format + value-gate path unchanged; main push still runs full CI if code paths match | N/A — docs-only may not trigger full ci on PR paths |
| E6  | GitHub runner queue under burst                       | Queue delay, not cancel; tip still gets a final conclusion                                | Temporary “pending” longer — acceptable free        |
| E7  | Expression bug (`github.ref` wrong)                   | Main still cancels                                                                        | Detect via F6; fix expression                       |
| E8  | Staging deploy                                        | Unchanged (`cancel-in-progress: false` already)                                           | N/A                                                 |
| E9  | Thrift / hold ships revived by mistake                | Still VOID; this change is opposite of thrift                                             | Reject any spend-cap PR                             |
| E10 | Swarm width 16+                                       | Unchanged spawn law; heal is one row not “stop all spawns”                                | Re-introducing all-hands freeze                     |

**Audit verdict:** Design keeps unlimited parallel craft. Only trunk **signal** and **merge onto red tip** change. Required checks remain residual (Class X).

---

## 5 · Implicit requirements (locked)

| Need                          | How satisfied                                                     |
| ----------------------------- | ----------------------------------------------------------------- |
| Hammer / no artificial limits | No merge queue, no PR cap, no cancel-as-throttle on main          |
| Money trunk honesty           | Every merge allowed to finish CI; heal before more product merges |
| Agents do everything          | Law is agent-readable; Nitro only if Class X block                |
| Denon alignment               | Same greenlit shape: keep green goal, fix machinery               |
| Finish is checkable           | §3 F1–F6                                                          |
| No thrift                     | Spend language remains VOID                                       |

---

## 6 · Residuals (named)

| Residual                                   | Owner                                     | Why not now                                                                 |
| ------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| Required status checks on main             | Nitro + Denon (GitHub settings / Class X) | Needs human settings go; not in files alone                                 |
| F6 live observation                        | Next swarm cycle after merge              | Needs real post-merge run list                                              |
| Flake storm under more completed main runs | Agents                                    | More finishes may surface flaky tests — fix flakes, do not re-enable cancel |

---

## 7 · Leverage

Phase A: extend existing `ci.yml` concurrency + CONTRIBUTING law. No new service, no second SPA, no second book.
