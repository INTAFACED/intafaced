# Stream A floor — closed for leverage phase (2026-07-30)

**Status:** modular floor **ready to build on**. Research/orchestration upgrades land **on top**, not as a rebuild of this floor.  
**PR:** [#182](https://github.com/Phantom-X-007/intafaced/pull/182)  
**Product surface:** vendored shell `:8090` — **not** `apps/web`.

---

## Done (do not re-do)

| Layer                            | Proof                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Boot (`ui:boot`)                 | #169 on main — reuse, detached, Node 18, `/`+`/app.js` readiness                                  |
| Harness + design bar law         | #172 on main — Playwright, matrix, `STREAM-A-DESIGN-BAR.md`                                       |
| B1–B5 PROOF                      | Green: 10/10 cells, B4 canary red→green (artefacts under `.artifacts/uiproof/`)                   |
| Pass 3 auth empty≠error          | `PASS3_GREEN` — 3 tests + `shots-auth/`                                                           |
| Design-bar tokens + first polish | Token aliases, focus rings, MoneyIndex honesty, plane risk labels, terminal density/empty recipes |
| Agent runner for Pass 3          | `tooling/uiproof/run-pass3.sh` / `pnpm ui:proof:pass3`                                            |

---

## Intentionally open (next programs — not blockers for research)

| Item                             | Why open                                                           |
| -------------------------------- | ------------------------------------------------------------------ |
| Merge #182 when CI policy allows | Org CI still broadly red — local PROOF is Stream A truth           |
| Deeper density / S8 taste tour   | Elective product polish; Nitro taste when asked                    |
| Pass 4 pixel baselines           | After UI thrash settles                                            |
| Pass 5 real prices               | **#109** only — never fake                                         |
| Multi-agent leverage stack       | Other chat — workflows/skills/orchestration **consume this floor** |

---

## Immutable for any future leverage work

1. Proof exit = machine artefacts (`PROOF.md` / Pass 3 status), not “open localhost.”
2. One kit: **iView** + **#86** tokens — no second design system mid-flight.
3. Empty ≠ zero; writer ≠ certifier.
4. Serial gates: boot → harness → B → Pass 3 → polish → prices.
5. Replacing Playwright/boot only if the replacement maps 1:1 to the same exit criteria.

---

## Design bar score (this floor closeout)

| Checklist                                   | Status                                                              |
| ------------------------------------------- | ------------------------------------------------------------------- |
| No second design system                     | Pass                                                                |
| No fake prices                              | Pass (no S2)                                                        |
| Empty ≠ zero (Exchange + MoneyIndex)        | Pass                                                                |
| Tokens §2 aliases                           | Pass                                                                |
| Honesty loading/empty/error distinct        | Pass (class recipes)                                                |
| Order type one control group                | Pass                                                                |
| Plane custodial / non-custodial labels      | Pass                                                                |
| Tabular nums + focus rings                  | Pass                                                                |
| Terminal density (book/form/rail alignment) | Pass (layout/gap/control height) — further aesthetic depth elective |
| Performance budget noted                    | Pass (documented debt)                                              |
| Charts as truth                             | Out of scope until #109                                             |

---

## One line for the research chat

> Stream A has a **proven shell + honesty + token law + Pass 3**. Perfecting leverage is welcome; **rebuilding the floor is not**, unless a new system meets the same PROOF/canary/empty≠error gates.
