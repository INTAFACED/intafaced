# Is our alignment approach “how seniors / agentic eng do it” — or over-engineering?

**Type:** Research + judgment (not a new mega-process)  
**Date:** 2026-08-03  
**Question:** Should we run the full ALIGNMENT program, or a thinner “right way”?

---

## Verdict (one line)

**The _goals_ are normal and correct for agentic teams. A 7-wave program with dozens of gates is heavier than seniors usually keep permanently — keep a thin operating system, cut the ceremony.**

---

## What research says is normal (2025–2026)

### Senior / classic engineering

- **Single source of truth** for decisions; link, don’t copy the same table into five docs (stale duplicate = classic failure).
- **Code + tests** carry day-to-day truth; docs capture _law and orientation_, not every chat.
- Monorepos win on **one place for conventions** — same idea as “agents need one entry,” not 189 competing briefs.

### Agentic engineering (how strong AI-assisted teams work now)

| Practice                                                              | Status in field                                                           | Our situation                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Short always-on instructions** (AGENTS.md / agent-entry.md / rules) | Standard “context engineering”                                            | You already have this — **keep, keep thin**                                  |
| **Git worktrees for parallel agents**                                 | Mainstream pattern (Nx, Cursor multi-agent guides, many 2025–26 writeups) | **Keep** — you already use them; 142 rotting trees is the bug, not worktrees |
| **Fetch tip / don’t trust stale local**                               | Basic professionalism                                                     | **Keep** — your laptop is 160 behind                                         |
| **Specs / ADRs for money & product law**                              | Rising “spec-driven” + old ADR practice                                   | **Keep** ADRs you already accepted                                           |
| **Land orientation on main so cold agents see it**                    | “Repos in repo,” knowledge priming                                        | **Keep** — maps only on laptop = agents drift                                |
| **Giant parallel doc piles / multi-wave meta-programs**               | Anti-pattern when they **duplicate** and go **stale**                     | **Cut** — research/FRONTEND\* dumps are the risk                             |
| **Monolithic 2000+ word root prompts**                                | Called out as signal dilution                                             | **Don’t grow** session paste into a novel                                    |

Sources (field practice, not blog folklore alone): monorepo.tools on single SoT; SIGPLAN “repositories as human/agent knowledge factories” on **stale duplicate** as top agent failure; Packmind context-engineering playbook on scoped rules vs monolith prompts; widespread 2025–26 worktree+multi-agent guides; Fowler/Willison line: **agentic engineering ≠ vibe coding** (tests, real docs, responsibility).

---

## What “right way” means for _you_ (3 people + heavy agents)

Not FAANG process. Not zero process.

**Minimum viable alignment (MVA) — this is the senior move:**

1. **One product default on main** (shell :8090; not apps/web) in START-HERE + session prompt + AGENTS.
2. **Always worktree from fetched `origin/main`.** Never code on dirty main.
3. **≤1 short law pack on main** (vendored exchange kit one-pager + “what not to rebuild” + owners) — **link**, don’t fork.
4. **`gh pr list` + don’t touch open Denon/Shehzad paths** — re-derive every session (no frozen PR table as law).
5. **Ship FE on shell** after that. Cleanup of worktrees/docs is **background**, not a multi-week gate before product.
6. **CI gates** that encode law (you already have brand/custody/workspace-sync) > more markdown.

**That’s how agentic seniors move:** small durable constraints in-repo + isolation + tip discipline + ship. Not a permanent “Wave W0–W7 program office.”

---

## What would be vibe-coded over-engineering (limit you)

| Pattern                                                                  | Why it limits you                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Treating **189 untracked research docs** as the system                   | Agents pick wrong file; you never finish “cleanup”                                                                           |
| **Re-running full recovery archaeology** every week                      | Already done; diminishing returns                                                                                            |
| **Seven mandatory waves before any FE PR**                               | Process becomes the product                                                                                                  |
| **Multiple “truth” docs** with the same ownership table                  | Stale duplicate — field’s #1 agent failure                                                                                   |
| **Keeping 142 worktrees** “in case”                                      | Disk + false lost-work anxiety (field reports 100s of worktrees as cost of agents — **GC is normal hygiene**, not a project) |
| **Building a second process framework** on top of AGENTS + ADR + tracker | You already have law; add _entry refresh_, not a new religion                                                                |

---

## Judgment on our written ALIGNMENT program

| Part of program                                    | Keep?           | Note                                                     |
| -------------------------------------------------- | --------------- | -------------------------------------------------------- |
| Product law (shell, ledger, owners)                | **Yes**         | Core                                                     |
| Land 5–6 maps on main + refresh START-HERE/session | **Yes**         | One PR; high leverage                                    |
| Stop dirty-main coding                             | **Yes**         | Non-negotiable                                           |
| Discard local shell regressions                    | **Yes**         | 5 minutes                                                |
| #425 / purge review                                | **Yes**         | Real work items                                          |
| Residual → short FE board                          | **Yes**         | Thin list, not a campaign OS                             |
| Full W0–W7 as permanent ritual                     | **No**          | Use as **optional checklist once**, then delete ceremony |
| Bulk GC 294 branches as blocking                   | **No**          | Do in idle agent pass; don’t block FE                    |
| Archive research docs                              | **Yes, lazily** | Zip/delete offline; don’t PR bulk                        |

---

## Recommended path (research-backed, proportional)

**Do this week (thin):**

1. One **docs PR**: START-HERE + session prompt refresh + link vendored exchange kit peace map + recovery one-screen + owners.
2. Agents: **worktree only** from tip.
3. Merge **#425** when green.
4. First **shell FE** tasks from residual/i18n scan — product motion.

**Do when free (hygiene, not drama):**  
5. Delete merged worktrees / squash-ghost branches.  
6. Archive local research docs outside git or trash.

**Do not:**

- Invent another 40-page process.
- Wait for “perfect clean laptop” before shipping.
- Re-litigate vendored exchange kit vs apps/web every chat.

---

## Bottom line for Nitro

| Question                                                       | Answer                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| Is alignment “how seniors do it”?                              | **Yes** for _thin_ SoT + tip + isolation + clear product. |
| Is a huge multi-wave cleanup program how they live day to day? | **No** — that’s crisis recovery, not steady state.        |
| Is worktree + AGENTS.md agentic best practice?                 | **Yes** — widely adopted 2025–26.                         |
| Will thick process limit you?                                  | **Yes** if docs multiply and ship waits on janitor waves. |
| Right move?                                                    | **Thin OS on main + ship shell. Hygiene in background.**  |

---

_This verdict constrains the ALIGNMENT program: execute MVA, not the full ceremonial wave list as permanent law._
