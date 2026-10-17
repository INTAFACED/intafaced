# Permanent hygiene — executable spec (peace of mind)

**Status:** executing 2026-08-03 · **Owner:** agent (Nitro never runs this by hand)

## Implicit needs

- Folder matches GitHub tip when opened (no “171 behind” fear)
- Agents always start from tip without Nitro
- GC does not delete unpushed real work
- Ship is never blocked on cleanup
- One durable way to re-run hygiene forever

## Success gates (finished = all true)

| #   | Gate                                                             |
| --- | ---------------------------------------------------------------- |
| G1  | Main checkout `HEAD == origin/main`                              |
| G2  | No tracked dirty files on main checkout                          |
| G3  | Safe ghost worktrees removed (cherry-empty + clean)              |
| G4  | Dirty / unique worktrees **kept** and listed                     |
| G5  | `tooling/scripts/worktree-gc.mjs` exists (re-runnable)           |
| G6  | Hygiene law doc on a PR or main                                  |
| G7  | Stress: new worktree from tip succeeds + preflight commands work |

## Non-goals

- Delete all 143 worktrees (unsafe)
- Bulk-delete untracked research docs this pass
- Feature FE / Denon PR merges
- Auto hard-reset on a schedule without human/agent review of dirt

## Procedure

1. fetch origin/main
2. classify worktrees → SAFE / DIRTY / KEEP
3. reset --hard origin/main on main checkout (discard tracked regressions)
4. remove SAFE worktrees (+ delete local branch if only used there)
5. add worktree-gc script + gitignore noise if missing
6. PR docs+script from tip worktree
7. audit G1–G7
