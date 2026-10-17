# PROOF-MODE

**Current:** NO-FLEET (Docker not present on host)

| Mode     | When                             | Proof allowed                                                                                        |
| -------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| FLEET    | Docker healthy, compose fleet up | Visual + uiproof against **own** worktree :8090                                                      |
| NO-FLEET | No Docker                        | Static scans + golden tests only. Stamp `proof_missing: fleet-blocked`. **Never** claim visual done. |

## :8090 foreign-worktree law

If a process is listening on `:8090` and its cwd is **not** this worker's worktree → visual proof is **INVALID**. Do not screenshot or claim UI green against someone else's tree.

**Live squatter (Coord-OPS 2026-08-03):**

| Port    | PID (snapshot) | cwd                                                          |
| ------- | -------------- | ------------------------------------------------------------ |
| `:8090` | node (foreign) | `.worktrees/feat-app-wave-continue` (`feat/app-b12-uiproof`) |

Workers must not treat that server as proof for any other claim/branch. Prefer `proof_missing: fleet-blocked` under NO-FLEET.

Regenerate context: `pnpm swarm:freeze` · dashboard: `docs/ops/DASHBOARD.md`
