# Nitro parallel ops — how pros run many agents without you as the bus

**Snapshot:** 2026-07-29  
**Audience:** Nitro (non-technical director) + any agent he spawns  
**Why this exists:** Today’s Grok multi-chat day _worked_ (open “what can we do?”, agents scavenge sibling sessions, stay compatible). Pros keep **that directing style** and replace the fragile part: **you as cross-chat memory**.

If this file disagrees with live git/PRs, **live state wins** — re-check, then fix this file.

---

## 1. Verdict (one breath)

**Your method is already a pro _director_ pattern.** The upgrade is not “better prompts only.”  
It is a **live claim board + worktrees + one air-traffic chat**, with Orca/Grok tools in the right slots.

| Keep (this is the speed)                  | Replace (this is the waste)                                          |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Cognitive depth + “yo what can we do?”    | You re-explaining every chat to every other chat                     |
| Agents finding non-overlapping mountains  | Agents rediscovering siblings by scavenging session files every turn |
| AFK / full autonomy + peace-of-mind close | Merge/ship anxiety because lanes were never claimed on disk          |
| Parallel volume without you reading code  | 6–10 equal chats all “owning” the same vague mission                 |

---

## 2. What you were already doing (named)

From real Grok sessions (e.g. **PEACE-OF-MIND parallel**, **what we can work on?**):

1. **Open the lane** — not a micro task list.
2. **Sibling awareness** — “look at other Grok sessions; don’t take their work.”
3. **You as router** — green lights, “theirs or ours?”, merge/leave.
4. **Sometimes structured fan-out** — one chat writes handovers; you paste into implementers.

That last mode is already close to pro. The gap: **ownership lived in chat memory**, not a file every agent must update.

---

## 3. How pros actually do this (plain)

Pros do **not** rely on “chat A reads chat B’s brain.” They share **three surfaces**:

| Surface         | What it is                                       | Your repo already has pieces                                                           |
| --------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Claim board** | Who owns which lane _right now_                  | Tracker claims, `SPLIT-BOARD.md`, Stream A claim — need one **live multi-agent board** |
| **Isolation**   | Separate folders/branches so files don’t collide | Worktrees (`pnpm wt`), Orca worktrees                                                  |
| **Proof**       | PR + CI + short status you can check             | `pnpm verify`, GitHub PRs, START-HERE                                                  |

**Cross-memory hierarchy (strict order):**

1. **GitHub + git tip** (`gh pr list`, branches, CI) — live high water
2. **Live claim board** (`docs/LIVE-LANES.md`) — who is coding what _now_
3. **Ownership law** (`docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md`) — who directs vs executes/merges
4. **Product / campaign docs** (residual campaign, START-HERE, PEACE-OF-MIND, frontend SoT)
5. **Grok session files** — only if board is missing/stale
6. **Grok experimental memory** — soft prefs only, **never** lanes / tip / merge rights

Memory (`GROK_MEMORY=1` / `[memory] enabled`) is useful for “Nitro hates code dumps.” It is **not** a substitute for a claim board.

---

## 4. Tools you already own (use the right one)

### A. Grok Agent Dashboard (default for your voice style)

- Open: `grok dashboard` or inside a session **`/dashboard`** / **`Ctrl+\`**
- See all top-level agents: needs input / working / idle
- Dispatch new agents from one screen; rename/pin so lanes have names
- **Best for:** your current style — several long-lived Grok sessions you voice-direct

**Rule:** every row gets a **lane name** (rename): e.g. `audit-money`, `stream-a-ui`, `merge-ready`, `token-gov`. Idle anonymous chats are how collisions start.

### B. Repo claim board (the real “cross-memory”)

Create/update: **`docs/LIVE-LANES.md`** (template below).  
Every agent, **before editing code**, reads + claims a lane. Every agent, **before “done”**, updates status + PR link.

This is what pros mean by shared state — not magical agent telepathy.

### C. Orca (when you want the machine to own isolation)

Orca is **running** on this machine. Two different modes (do not mix them up):

| Mode                         | When                                                         | What happens                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Full handoff**             | “Give this to another agent / worktree and stop babysitting” | `orca worktree create --agent grok --prompt "…" --no-parent` (or other installed agent ids). Original chat **stops monitoring**. |
| **Supervised orchestration** | “Coordinate a DAG, wait for workers, decision gates”         | `orca orchestration task-create` + `dispatch --inject` + `check --wait`. **Only** when you explicitly want supervision.          |

**Do not** start with full Orca orchestration for every day. That is the pro path for _supervised multi-worker runs_, not for open “what can we do?” directing.

**Operator path for you (no ceremony):**  
Say to **one** coordinator Grok chat:  
_“Open three Orca worktree handoffs for lanes X/Y/Z using the parallel prompt; update LIVE-LANES; only ping me for money/product forks.”_  
The agent runs Orca; you never touch the CLI.

### D. Grok subagents / workflows (inside one chat)

- Subagents: good for **research / audit shards / parallel read** under one parent
- Workflows (`/workflows`): good for **repeatable multi-step pipelines**
- **Not** a replacement for multi-session product lanes that each need their own PR/worktree

### E. What is _not_ enough alone

- “Check other Grok sessions” every turn → works, burns tokens, goes stale after compact
- Pasting huge handovers by voice → works once; doesn’t scale to 6+
- Experimental memory alone → no claim/lock semantics

---

## 5. The operating loop (what you do vs what agents do)

### You (2–5 minutes to open a parallel block)

1. One sentence of **intent** (audit / front-run backend / Stream A / merge-ready / surprise Denon).
2. Open **dashboard** (or one coordinator chat).
3. Say: **“Run parallel ops for: …”** (paste block in §7).
4. Later: glance **LIVE-LANES + PR links**; green-light only money/product forks.
5. When tired: **“AFK — finish merge-ready, update board, only escalate real blockers.”**

### Agents (mandatory, every parallel session)

1. Read `docs/LIVE-LANES.md` + `gh pr list` + open worktrees.
2. **Claim a free lane** (or invent one that doesn’t overlap) — write board first.
3. Worktree only; never main checkout for edits.
4. Execute; sub-agents OK _inside_ the lane.
5. Update board: status, PR, “do not touch” paths.
6. Peace-of-mind close: what shipped, what’s still open, what’s **other lanes**.

### Coordinator chat (optional but pro)

One session that **only**:

- Maintains LIVE-LANES
- Spawns / renames workers
- Resolves “theirs vs ours”
- Does **not** implement heavy code itself when workers exist

You mostly talk to **this** chat. Workers get short lane briefs, not your whole day.

---

## 6. LIVE-LANES template

Path: `docs/LIVE-LANES.md`  
Agents: create if missing; keep short; delete completed rows after merge.

```markdown
# LIVE LANES — multi-agent claims (update every claim / release)

**Rule:** No code edits until your lane is on this board.  
**If conflict:** first claimer keeps lane; others pick a non-overlapping mountain.

| Lane id     | Owner session (rename) | Scope (paths / feature) | Status | PR / proof | Do not touch  |
| ----------- | ---------------------- | ----------------------- | ------ | ---------- | ------------- |
| stream-a-ui | session-…              | vendor shell UI         | wip    | #…         | services/\*\* |
| audit-delta | session-…              | post-Denon money delta  | done   | docs/…     | feat/app-\*   |

## Free mountains (ideas only — claim before build)

- …

## Last board update

- ISO time · which session · one line
```

---

## 7. Paste prompts

### 7A — Parallel open (your usual voice, upgraded)

Paste into a **new** Grok session (or dashboard dispatch):

```
PARALLEL OPS — director mode (Nitro)

WHO: I am Nitro — non-technical director with product depth. You own method + git/worktree/PR/verify. Plain language. I only gate money/custody/product-trust forks.

INTENT (one line I care about):
[ e.g. front-run backend while Stream A UI runs · mega audit new Denon ship · make everything merge-ready ]

HOW PROS RUN THIS (do not skip)
1. Read docs/NITRO-PARALLEL-OPS.md + docs/START-HERE.md + docs/LIVE-LANES.md (create LIVE-LANES from the template in PARALLEL-OPS if missing).
2. Re-check live: gh pr list, git worktree list, active Grok sessions under ~/.grok/sessions for this repo (titles + last user intent only).
3. CLAIM a non-overlapping lane on LIVE-LANES BEFORE any code edit. Rename this session to the lane id.
4. Worktree only. Never main checkout. Never stomp another lane’s paths/PRs.
5. Compatible with Denon + other chats: if a mountain is already claimed, pick another or wait — do not “helpfully” dual-own.
6. Sub-agents OK inside this lane only. Do not spawn silent sibling product lanes without updating LIVE-LANES.
7. Go all out inside the claim: plan completeness, quality, merge-ready if shipping. AFK-safe: only escalate true blockers.
8. Close with: board update · what shipped · what’s other lanes · PR links · what I must decide (if any).

OPEN MOVE
- If INTENT is open-ended: propose 2–4 free mountains that do NOT collide; claim the best one; execute.
- If INTENT is a named mission: claim it, then execute.
```

### 7B — Coordinator only (air traffic)

```
You are PARALLEL COORDINATOR only — not the main implementer.

1. Own docs/LIVE-LANES.md truth.
2. Inventory sibling Grok sessions + PRs + worktrees.
3. Propose lane map (3–6 max). I green-light or say “go”.
4. After go: spawn/dispatch workers (Grok dashboard or Orca worktree handoffs with agent grok). Each gets a short lane brief + PARALLEL OPS rules.
5. You do not deep-implement unless a lane is empty and urgent.
6. When I say AFK: chase merge-ready + board hygiene; ping only on money/product forks or hard collisions.
```

### 7C — One-shot implementer (structured fan-out)

Keep using this when a coordinator already named the mountain (webauthn, staking, …). Add at top:

```
Lane id: <id>
Board: claim docs/LIVE-LANES.md first; release on PR open or merge.
Sibling rule: do not expand scope into other LIVE-LANES rows.
```

### 7D — Evening mega-audit / “I’m tired”

```
AFK PARALLEL CLOSE

Read LIVE-LANES + other sessions’ claims. Finish only what THIS lane owns.
Make merge-ready (verify, PR, board update). Do not invent new lanes unless board shows free high-value work with zero collision.
I want peace of mind: GitHub shows everything from this block; board is honest; open leftovers are named as other lanes or true blockers.
```

---

## 8. Recommended day shape (same speed, less bullshit)

| Phase | What                                                    | Tool                                |
| ----- | ------------------------------------------------------- | ----------------------------------- |
| 0     | One coordinator chat                                    | Grok                                |
| 1     | Board + free mountains                                  | LIVE-LANES + tracker + law          |
| 2     | 3–5 named lanes max                                     | Dashboard dispatch or Orca handoffs |
| 3     | You voice-steer only when a lane needs product judgment | Dashboard peek/reply                |
| 4     | AFK close                                               | merge-ready + board                 |
| 5     | You leave with PR list + board, not 10 chat histories   | GitHub                              |

**Ceiling:** more than ~5 concurrent _editing_ lanes without a board → collision tax exceeds speed. Research/read-only shards can be more.

---

## 9. Orca learning path for you (when ready)

You do **not** need to learn Orca to get 80% of the win (board + dashboard + worktrees).

When you want the last 20%:

1. Open Orca app (already running).
2. Tell coordinator: _“Handoff lane X as Orca worktree with agent grok.”_
3. Later: _“What’s on worktree ps?”_ — agent runs `orca worktree ps --json`.
4. Only if you ask for supervised multi-worker runs: orchestration DAG.

Full handoff ≠ orchestration. Handoff = fire and forget. Orchestration = someone waits.

---

## 10. What not to do

- Six chats all told “do everything Denon shipped” with no claims
- Implement on main checkout
- Edit Stream B / money spine from Stream A without explicit go (see SPLIT-BOARD; offline exceptions are temporary banners only)
- Treat compacted chat memory as source of truth
- Enable Grok memory and assume agents will “just know” open PRs

---

## 11. Success criteria

You’re doing it “pro” when:

1. You can open **one file** (LIVE-LANES) and see every active mountain.
2. You can leave for 2 hours and return to **PRs + board**, not “what did chat 4 think?”
3. Agents still answer **“what can we do?”** by proposing free mountains — they just **claim first**.
4. Speed ≥ today’s voice day; collision anxiety ↓.

---

## Related

- `docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md` — durable direction vs execution/merge law
- `docs/NITRO-SESSION-PROMPT.md` — paste every coding chat
- `docs/NITRO-RESIDUAL-CAMPAIGN-2026-07-31.md` — residual program
- `docs/START-HERE.md` — product map
- `docs/SPLIT-BOARD.md` / `docs/DENON-NITRO-PARALLEL-BOARD-2026-07-30.md` — history only; do not block residual execution
- Grok: optional memory for soft prefs only — never lanes/high water
- Orca: `orca skills get orca-cli` · `orca skills get orchestration` (agents run these)
