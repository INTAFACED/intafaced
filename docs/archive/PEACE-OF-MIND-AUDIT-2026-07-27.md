# Peace-of-mind audit — automatic collab workflow

**Date:** 2026-07-27  
**Question:** Will every future chat, without Nitro enforcing it, work the right way with Denon?  
**Verdict (updated mid-ship):** Rules + START-HERE + session prompt live on branch `chore/agent-operator-flow` → open as PR; **still not automatic until that PR is merged to `main`.** After merge + pull, every chat that loads this repo gets operator/Denon modes.

`[VERIFIED 2026-07-27]` against local disk + `origin` + GitHub API.

---

## What you wanted (including unspoken)

| Need                  | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| Peace of mind         | One honest yes/no with proof, not hope                           |
| Automatic for _you_   | Agents run git/worktree/PR; you get links + plain language       |
| Automatic for _Denon_ | His agents self-audit + worktrees without him re-reading process |
| Fast                  | No mutual-Approve theater                                        |
| Not embarrassed       | Don’t claim “we set it all up” if GitHub still has old AGENTS    |
| Complete plan         | Know every layer: docs → git → GitHub → agent load → human habit |

---

## Audit plan (what matters — complete set)

| Layer | What to check                                                             | Why it matters                                  |
| ----- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| L1    | Rules written (operator mode, asymmetric review)                          | Content exists                                  |
| L2    | Committed on a branch                                                     | Survives a closed chat                          |
| L3    | On GitHub `main`                                                          | Denon + his agents + your other machines see it |
| L4    | Entry chain (project agent entry file → `AGENTS.md`) points at full rules | Cold agent loads them                           |
| L5    | Rules match the agreed model (no forced mutual Approve)                   | Docs don’t fight the plan                       |
| L6    | Mechanical guards (hook, CI, Free limits)                                 | What is enforced vs honor                       |
| L7    | Nitro path needs zero git homework                                        | Unspoken: you can’t self-enforce                |
| L8    | Denon path is agent-default, not lecture-only                             | Unspoken: he forgets process                    |
| L9    | This chat / local dirty state doesn’t fake “done”                         | False confidence                                |

---

## Results

| Layer               | Status                   | Proof                                                                                                                                                                   |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 Written          | **Partial — local only** | Full text in `.worktrees/chore-agent-operator-flow/AGENTS.md` (uncommitted).                                                                                            |
| L2 Committed        | **No**                   | Branch `chore/agent-operator-flow` has `M AGENTS.md`, `M CONTRIBUTING.md`, `?? MESSAGE-DENON…` — **no commit**.                                                         |
| L3 On `origin/main` | **No**                   | Remote `AGENTS.md` has **no** “operator / asymmetric / Denon / Nitro mode”.                                                                                             |
| L3 PR open          | **No**                   | No PR for `chore/agent-operator-flow`.                                                                                                                                  |
| L4 Entry chain      | **Weak**                 | Project agent entry → “read AGENTS.md” works, but live AGENTS is the **old short** file. Entry file still says _ask the human_ to run `pnpm wt` — fights operator mode. |
| L5 Model match      | **Draft only**           | Asymmetric review is in the **worktree draft** CONTRIBUTING, not on GitHub. Remote CONTRIBUTING still says mutual review.                                               |
| L6 Mechanical       | **Partial**              | CI yes. Branch protection **no** (Free). `pre-push` mode **644** (may not run).                                                                                         |
| L7 Nitro auto       | **Not on main**          | Operator mode only in uncommitted worktree draft.                                                                                                                       |
| L8 Denon auto       | **Not on main**          | Same. He must also open agents **in this repo** so they read `AGENTS.md`.                                                                                               |
| L9 Dirty local      | **Confusing**            | Local `main` ahead 1 (token AGENTS commit not necessarily on remote path clarity); uncommitted collab docs; `.worktrees/` present. Easy to think “we already fixed it.” |

### Bottom line in one line

**Drafted in a side folder · not committed · not on GitHub · not what Denon’s next agent will load.**

---

## What _is_ already automatic (even without the new draft)

These already live on GitHub `main` and help every agent that reads the repo:

- Worktree rule in `AGENTS.md` / project agent entry (stop if main checkout)
- `pnpm verify` before “done”
- Doctrine hard stops in agent protocol
- CI on every PR
- CONTRIBUTING GitHub Flow + `pnpm wt`

So the **base** collab structure is real. What’s **missing** is the **operator loop** (agents do git/PR for Nitro) and **asymmetric review** (don’t wait on Nitro’s Approve).

---

## What “done” looks like (peace of mind checklist)

All must be true:

1. Operator + Denon modes committed
2. PR opened and **merged to `main`**
3. `gh api …/AGENTS.md` raw text contains `Nitro operator mode`
4. Project agent entry updated so agents **create worktrees / run the loop**, not “ask Nitro to run pnpm wt”
5. Denon pulled / next agent session on fresh `main`
6. Optional: `pre-push` executable bit fixed in same PR

Until 1–3: **do not believe it is automatic.**

---

## What cannot be 100% automatic (honest limits)

| Limit                                  | Reality                                            |
| -------------------------------------- | -------------------------------------------------- |
| Agents outside this repo               | A chat with no project root won’t load `AGENTS.md` |
| Denon ignoring AGENTS                  | Docs don’t force behavior; CI + habit do           |
| Free GitHub                            | Cannot block merge without review                  |
| You must open agent **in the project** | Folder context is how rules load                   |

“All chats forever” = **all chats started on this repo after rules are on `main`**, with agents that load project docs. That is the honest ceiling.

---

## Next action (one)

**Ship the draft:** commit on `chore/agent-operator-flow` → PR → Denon merges → verify remote `AGENTS.md` contains operator mode.

Until you say **ship it**, that step is not done (standing rule: no commit/PR without your ask).
