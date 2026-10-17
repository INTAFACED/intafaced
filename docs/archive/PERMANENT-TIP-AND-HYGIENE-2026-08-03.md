# Permanent tip freshness + hygiene — analysis (not more process theater)

**For:** Nitro (autonomous, no manual git) + agents  
**Question:** Must I always “janitor” manually, or is there a permanent fix that doesn’t limit speed?  
**Consensus target:** how agentic engineers actually run multi-agent monorepos in 2025–26.

---

## 0 · Enhanced prompt (implicit needs)

| Explicit                            | Implicit (must satisfy)                                  |
| ----------------------------------- | -------------------------------------------------------- |
| Permanent solution for stale laptop | Never feel “we lost the project” because a folder is old |
| Not always manual janitoring        | **You** never run git; agents own freshness              |
| Plan complete                       | Name every failure mode + what fixes it                  |
| Don’t limit me                      | No multi-week cleanup gate before shipping               |
| How people like me do it            | Solo/director + heavy agents + partners on GitHub        |
| Combat negatives                    | Dual product, dirty main, 100 worktrees, stale docs      |

**Done means:** agents always start from tip; main checkout can’t poison work; hygiene is **automatic or rare agent pass**, not your job.

---

## 1 · Verdict (one breath)

**You do not need a new architecture.**  
You already have the right **design** (`pnpm wt` fetches `origin/main`, AGENTS bans coding on main checkout, #450 law on main).

**What’s broken is operational:** the **main folder** is treated like “the project,” stays dirty, never updates — so it _feels_ like permanent staleness.

**Permanent fix = make tip the only place agents work + automate/agentize hygiene.**  
Not “Nitro pulls every day.”

---

## 2 · Why the laptop goes stale (root causes)

| #   | Cause                                                                       | Permanent?        |
| --- | --------------------------------------------------------------------------- | ----------------- |
| 1   | **GitHub is the factory** — Denon merges while your folder sleeps           | Normal            |
| 2   | **Agents correctly refuse dirty main** → nobody `fetch`/`reset`s it         | By design (good)  |
| 3   | **You don’t run git**                                                       | By design (good)  |
| 4   | **Worktrees are created from fetch** but **old worktrees** stay on old SHAs | Normal agent debt |
| 5   | **Untracked docs + dirty files** block casual “update main”                 | Local debt        |
| 6   | **Human opens main folder in IDE/chat** as default workspace                | Habit risk        |

**Consensus:** In multi-agent setups, **stale clones are expected**. Pros don’t keep one dirty long-lived working tree as truth — they **recreate isolation from remote tip** every task.

---

## 3 · How agentic engineers actually do it (consensus)

| Practice                                   | Normal?                                         | Your repo today                       |
| ------------------------------------------ | ----------------------------------------------- | ------------------------------------- |
| Remote `main` = source of truth            | Yes                                             | Yes                                   |
| **New worktree per task from fetched tip** | Yes (Nx/Cursor/coding agent multi-agent guides) | `pnpm wt` already fetches             |
| Never implement on shared main checkout    | Yes                                             | Written in AGENTS                     |
| Short AGENTS.md / session rules on main    | Yes                                             | Yes + #450 pack                       |
| PR + CI merge                              | Yes                                             | Yes                                   |
| Human never touches git                    | Less common but fine if **agent owns loop**     | Nitro operator mode                   |
| 100+ uncleared worktrees                   | Common **failure** under agents                 | You have this — hygiene, not redesign |
| Human “file genitoring” weekly by hand     | **No** — agents/cron GC                         | Should not be your job                |
| Perfect always-synced main folder          | **Not required** if unused for code             | Optional comfort reset                |

**Willison-style agentic eng:** isolation + tip + tests/docs as discipline — not a forever-clean home directory.

---

## 4 · What would limit you (combat these)

| Limiter                                     | Why bad                | Combat                                      |
| ------------------------------------------- | ---------------------- | ------------------------------------------- |
| “Clean laptop for a week before any FE”     | Blocks ship            | Hygiene parallel/background                 |
| Requiring Nitro to pull/reset               | Breaks autonomous      | Agent-only preflight                        |
| 189 docs as living law                      | Stale duplicates       | One entry pack on main (#450); archive rest |
| Coding in main checkout “because it’s open” | Instant drift          | IDE default = empty / “open worktree only”  |
| Keeping every worktree forever              | Disk + false lost-work | `wt:rm` after merge; weekly agent GC        |
| Freezing PR lists in docs                   | Lies in hours          | Always `gh pr list` live                    |
| Second process framework                    | Cognitive tax          | Thin rules only                             |

---

## 5 · Permanent solution (three layers)

### Layer A — Structural (already mostly done) — **keep**

1. Product law + owners on **main** (#450).
2. **Never implement on main checkout** (AGENTS).
3. **`pnpm wt` always fetches** before create (already in script).
4. Operator mode: agent does git/PR.

**You never janitor this layer.**

### Layer B — Session automation (agents, every chat) — **enforce, zero Nitro**

Mandatory preflight (already in session prompt post-#450):

```
fetch origin/main
if cwd is main checkout → create worktree; refuse implement
gh pr list
read START-HERE / vendored exchange kit map if needed
```

**If agents follow this, staleness cannot affect new work.**  
This is the permanent “don’t go stale” control.

### Layer C — Hygiene automation (periodic, agent or tiny hook) — **not your hands**

| Job | Frequency                        | Who                 | What                                                                                                 |
| --- | -------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| C1  | Every coding session             | Agent               | Worktree from tip only                                                                               |
| C2  | After each merge of _their_ PR   | Agent               | `pnpm wt:rm` that branch                                                                             |
| C3  | Weekly or when disk hurts        | One agent “GC pass” | Remove worktrees whose branch is merged/gone; prune local squash-ghost branches                      |
| C4  | Rare (when main folder confuses) | One agent           | Safe reset main checkout → `origin/main` (discard regressions; keep only listed untracked if needed) |
| C5  | Optional                         | Launchd/cron later  | `git fetch` in main clone + report behind-by-N — **never auto hard-reset dirty tree**                |

**You never run C2–C4 yourself.** Say “GC worktrees” or it runs on a schedule via agent.

---

## 6 · Do you need to _change_ things permanently?

| Change                                      | Needed?                                | Limits speed?                |
| ------------------------------------------- | -------------------------------------- | ---------------------------- |
| New monorepo layout                         | **No**                                 | —                            |
| Stop using worktrees                        | **No** — opposite                      | —                            |
| Nitro daily pull                            | **No**                                 | Would limit autonomy         |
| Make agents always tip-worktree (hard rule) | **Yes** — already written; **enforce** | Speeds you (less wrong work) |
| Auto-delete worktree after merge            | **Yes (agent habit)**                  | Speeds (less mess)           |
| Occasional main-folder reset                | **Nice**, not required if unused       | Comfort                      |
| More markdown programs                      | **No**                                 | Limits                       |

**Permanent solution in one sentence:**  
**Truth lives on GitHub; every task is a fresh worktree from tip; main folder is a library card, not a workshop; GC is agent-owned.**

---

## 7 · Complete plan (ordered, proportional)

### P0 — Already true after #450 (no work)

- Entry docs say fetch tip, shell product, owners.
- `pnpm wt` fetches.

### P1 — Behavioral lock (no new tools)

- Every agent session: refuse code if cwd = main checkout.
- After merge: `wt:rm`.
- **You:** open agent on repo; never “fix this folder.”

### P2 — One-time comfort (agent, optional)

- Reset main checkout to `origin/main` safely.
- After that, main folder matches GitHub when you open it.

### P3 — Background GC (agent, non-blocking)

- Script or one-shot: list worktrees, delete if branch merged/absent on remote and clean.
- Cap: never delete dirty worktrees without report.

### P4 — Optional later (only if still painful)

- SessionStart hook: fetch only.
- Dashboard: “main behind by N” in agent status line.
- Move default IDE root to a “current” worktree symlink agents maintain.

**Do not block FE ship on P2–P4.**

---

## 8 · Answers to your direct questions

| Question                                     | Answer                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| Permanent solution or always manual janitor? | **Permanent = agent tip-worktree + agent GC. Not manual you.**                    |
| Always file genitoring by hand?              | **No.** Occasional agent GC only.                                                 |
| Wrong workflows?                             | **Design OK. Habit of living in stale main is wrong.**                            |
| Wrong structure?                             | **No.**                                                                           |
| What limits us?                              | Dirty main as workspace · worktree rot · doc piles · starting work without fetch. |
| Consensus for people like you?               | Remote tip + ephemeral worktrees + PR + short repo law + human directs.           |

---

## 9 · Self-prompt for agents (handbook)

```
Nitro never janitors git by hand. Permanent anti-stale:

1) fetch origin/main every session
2) if main checkout → create worktree from origin/main; never implement on main
3) product = vendor shell :8090; apps/web not product
4) after merge: wt:rm that worktree
5) GC only on request or scheduled: remove clean worktrees for merged/gone branches; report dirty ones
6) never hard-reset a dirty main without listing what would be lost
7) do not invent multi-week cleanup programs that block shipping

Read docs/PERMANENT-TIP-AND-HYGIENE-2026-08-03.md + START-HERE anti-drift pack.
```

---

## 10 · What you should feel

- **Behind folder** ≠ failed project.
- **You are not the janitor.**
- **Agents are the broom and the conveyor belt.**
- **Ship stays unblocked** as long as each task starts from tip.

_Optional next agent job (one line): “P2 safe-reset main checkout to origin/main + report; P3 GC dry-run of worktrees.” Not required for law correctness._
