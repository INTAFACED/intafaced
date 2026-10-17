# Local git + Graphify — permanent criteria

> Graphify retired on 2026-10-11 at Nitro's request. The Graphify-specific requirements below are historical and no longer apply. Local Git and worktrees remain the working process; current instructions live in `AGENTS.md`.

**As of:** 2026-08-16 (re-derived). **Tip now:** `e4845854` (#2078, on top of #2079).  
**Home folder:** `~/projects/Sovereign` is local `main` = `origin/main`. Map present. Peace GREEN.  
**This file:** what “done properly” means. Agents re-derive the Now column; they do not quote it as live.  
**Not:** a reason to open more chats. Leftover cemetery is agent janitor, not a gate on Nitro.

Nitro never types git. Agents do. One coding chat in `~/projects/Sovereign` is enough.

---

## 1 · What you actually need (unspoken)

1. One project folder forever: `Sovereign`. You do not hop worktree paths.
2. Local git is the **working copy**. Graphify reads **disk**, not GitHub.
3. GitHub is **sync + Denon PRs**, not the knowledge base.
4. Dual-build: one cheap `gh pr list`, stay off his open files.
5. Agents query Graphify, update the map, cut/remove worktrees — **automatic for you**.
6. No 22 ghost trees. No 485-behind home. No “please rebase.”
7. Independent auditor because this planner chat is long and can drift.
8. You start coding chats now; leftover janitor is agent work, not a gate on you.

---

## 2 · Areas and pass/fail (the real list)

| Area                      | Pass looks like                                                                         | Fail looks like                                              | Now (RAN-IT 2026-08-16)                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A · Home checkout**     | `main`, `HEAD == origin/main`, no product edits                                         | Detached / hundreds behind / dirty cook                      | **PASS** `main` `377710c9` (#2076) = tip after `git pull --ff-only`. Untracked leftover planner/Orca docs only (named, not product)                                                                |
| **B · Worktrees**         | One tree per live cook, cut from **today’s** main, removed after merge                  | 20+ trees, 400–1700 behind, remotes `[gone]`                 | **PARTIAL** Registered live: home + this law tree. Cemetery checkouts removed (sidebar-gc); leftovers parked in named stashes. Three broken-git orphan folders remain under `sovereign-worktrees/` |
| **C · Graphify map**      | `graphify-out/graph.json` **in git** on tip; query works; corpus lock                   | Gitignored map; query missing; paste walls ingested          | **PASS** on tip. Peace RESULT GREEN (12/12). CLI 0.9.44                                                                                                                                            |
| **D · Graphify use**      | First code move = `graphify query` on the **worktree**                                  | Grep `services/` or GitHub file API as the map               | **INSTRUCTED**, not locked. Coding chats query local `graphify-out/graph.json`                                                                                                                     |
| **E · Graphify refresh**  | After code in `services/`/`packages/`: `graphify update .` and commit map if it changed | Map 128 commits stale vs files                               | **AGENT-MUST**. Hook **skips worktrees**. Peace: graph commit a few behind after #2078/#2076 — still GREEN                                                                                         |
| **F · GitHub role**       | `git fetch` + `gh pr list` once per cook                                                | Treating GitHub as the filesystem / “always rebase from web” | **PASS as law.** GitHub = remotes + Denon PRs. Disk + Graphify = working copy                                                                                                                      |
| **G · Dual-build**        | Re-derive Denon open PRs; no path intersect                                             | Dual-edit `svc-trade` / his open files                       | **LIVE** — re-derive `gh pr list` every cook. Do not quote this cell                                                                                                                               |
| **H · Token**             | Query + one file, not AGENTS.md + 16 coordinators                                       | 16 judgment chats; reread universe                           | **PASS method.** One chat. No executor/auditor paste mill. Agent cuts `pnpm wt` from tip                                                                                                           |
| **I · Stash / leftovers** | Stashes named and triaged or dropped                                                    | Mystery stashes, 84 dirty files on home                      | **PARTIAL** Freeze/lane-stop named trash. KEEP parked: `money.ts`, trade-mm, bank, TWAP, app-look, TV, blueprint                                                                                   |
| **J · Engine**            | Official `graphifyy` via `uv`, auto-upgrade                                             | Cloned Graphify-Labs; marketplace fiction                    | **PASS** `~/.local/bin/graphify` → `uv/tools/graphifyy` 0.9.44                                                                                                                                     |

---

## 3 · Permanent loop (do not invent another)

```
You open chat in ~/projects/Sovereign
        ↓
Agent: git fetch; if on main → pnpm wt feat/<job> from origin/main
        ↓
Local tree already has graph.json (from git)
        ↓
graphify query "<mountain>" → edit one file
        ↓
gh pr list (Denon collide only)
        ↓
graphify update .  (if services/packages changed) + commit map if needed
        ↓
PR → merge → pnpm wt:rm
```

**You never:** rebase, `cd` to worktree paths, extract, update, or “graphify peace” unless you want a check.

---

## 4 · What is still to fix (executor chat)

1. **Janitor worktrees** — `pnpm wt:gc` dry first; drop only SAFE/idle. Do **not** delete dirty trees until the leftover file is named trash or committed. Attended `--yes` only after the list is honest. Branch is never deleted by gc. After a sidebar wipe: leftovers live in `sidebar-gc 2026-08-16 *` stashes; restore with `pnpm wt <branch>` if a cook needs one.
2. **Stash triage** — name every stash; drop only proven coordinator/freeze/lane-stop noise. Never apply blindly. Never drop `packages/ledger-client` or trade/bank money hunks.
3. **Home stays at tip** — every agent that lands on `main` runs `git pull --ff-only` (never rebase home). Never detach home again.
4. **Do not invent GitHub-as-disk.** After pull, Graphify + files are local.
5. **Optional later:** Grok Bot `uv tool install graphifyy` once on its VM (map already in repo).
6. **Do not** re-enable whole-`~/projects` graph-autosync (burned a session once).

---

## 5 · New coding chats (Nitro)

Open **one** chat in `~/projects/Sovereign`. Do not paste an executor. Do not paste an auditor. Do not `cd`.

The agent: `git fetch` → if home is `main`, `git pull --ff-only` then `pnpm wt feat/<job>` from `origin/main` → `graphify query` on that tree → one `gh pr list` for Denon collide → ship.

Leftover cemetery / stash janitor is **agent work in the background**, not a reason to wait or to open a second chat.
