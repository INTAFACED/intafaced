# Swarm ops (generated board)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Law:** [`../SWARM-ALL-OUT-ORIENT-2026-08-03.md`](../SWARM-ALL-OUT-ORIENT-2026-08-03.md) · [`SWARM-MANDATE.md`](./SWARM-MANDATE.md)  
**Wave 1 tools:** `pnpm swarm:freeze` · `swarm:status` · `swarm:lanes` · `swarm:report` · `swarm:next`  
**Cold resume:** regenerate `FREEZE-LIVE.md` (`pnpm swarm:freeze`), then [`../COORDINATION-TRUTH-LAYERS.md`](../COORDINATION-TRUTH-LAYERS.md) § Agent cold-start.

**Committed FREEZE is not live law.** `FREEZE-LIVE.md` / `DASHBOARD.md` / `R00–R02` in git are snapshots. If the tip SHA inside FREEZE ≠ `origin/main`, treat every free/blocked/Actions number as **stale until regenerate**. Never hold work for thrift or Actions run-count — thrift is deleted; the repo is public. Never run `pnpm wt:gc:apply`; remove only your own worktree with `git worktree remove <path>`.  
**Human blockers inbox:** [`../BOARD-CLEAR-HUMAN-BLOCKERS.md`](../BOARD-CLEAR-HUMAN-BLOCKERS.md) (not a second file).  
**Value / churn metric (L0):** `tooling/ci/value-gate.mjs` on Docs format · `Board-Delta:` trailer.

| File                                       | How it appears                               |
| ------------------------------------------ | -------------------------------------------- |
| [DASHBOARD.md](./DASHBOARD.md)             | `pnpm swarm:report` — Nitro one-screen fleet |
| [FREEZE-LIVE.md](./FREEZE-LIVE.md)         | `pnpm swarm:freeze` — free vs blocked + cost |
| [FREEZE-LIVE.json](./FREEZE-LIVE.json)     | Machine form of freeze                       |
| [R00-INVENTORY.md](./R00-INVENTORY.md)     | Tip + free counts                            |
| [R01-PR-MATRIX.md](./R01-PR-MATRIX.md)     | Open PR babysit map                          |
| [R02-FREE-CLAIMS.md](./R02-FREE-CLAIMS.md) | Free/blocked list                            |

**State directories (not product docs):** `claims/` (spawn locks), `slices/` (agent-authored specs), `trk/` (tracker feature packs). Counted as machine state in freezes; do not move them out of `docs/ops` (brand-scan allowlists this tree). FREEZE-LIVE also lists **socket + owned non-done** rows (A9) so a quarter of the platform is not invisible on the free board.

**Do not hand-edit generated files** — re-run the scripts after tip moves.

**Kill switch:** remove `swarm:*` from `package.json` and delete `tooling/scripts/swarm.mjs` if these tools thrash; residual + `claim:check` remain.

**Money-path incident (who / detect / contain):** [`INCIDENT-MONEY-PATH-RUNBOOK.md`](./INCIDENT-MONEY-PATH-RUNBOOK.md) (D26-P3-10). Switch mechanics stay in [`../OPS-KILL-SWITCH-RUNBOOK.md`](../OPS-KILL-SWITCH-RUNBOOK.md).

## Denon hard board

**Live** invent-risk / product-complete mountains (agents babysit only): [`../LAST-MVP-BOARDS-2026-08-23.md`](../archive/LAST-MVP-BOARDS-2026-08-23.md). Historical 120-ID: [`../DENON-HARD-PARALLEL-BOARD-2026-08-09.md`](../archive/DENON-HARD-PARALLEL-BOARD-2026-08-09.md).  
**D26-P4-04 issue board:** [`ISSUE-BOARD-RECONCILE-D26-P4-04.md`](./ISSUE-BOARD-RECONCILE-D26-P4-04.md) (open GitHub issues vs tracker/ADR; close only with merged proof).  
D-S factory done: [`../SPEC-FACTORY-INDEX-2026-08-04.md`](../archive/SPEC-FACTORY-INDEX-2026-08-04.md).  
Historical shape: [`../DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md`](../DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md).  
**D26-P4-06** depth/tape honesty SLO (empty book stays empty; no fake latency number): [`DEPTH-TAPE-PRODUCT-SLO.md`](./DEPTH-TAPE-PRODUCT-SLO.md).
