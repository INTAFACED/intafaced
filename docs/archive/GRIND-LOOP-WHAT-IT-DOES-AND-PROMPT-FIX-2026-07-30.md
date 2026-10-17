# Grind loop — what it actually does + prompt fix

**Date:** 2026-07-30 · **Mode:** explanation + prompt upgrade (no product code)  
**Live high water at write:** main tip through **#216**; grind file still says #214  
**Your standard (stated this chat):** merge only after **audit → fix → debug**.

If live git disagrees, live wins.

---

## One breath

The loop is **not** “only auto-merge.” It has **two jobs**, and after the agent micro-queue emptied it mostly runs the second:

1. **Cook** — invent/ship agent-owned product PRs (now **DRAINED** / empty).
2. **Babysit** — find open PRs (usually **Denon’s**), run **gates + a short self-audit comment**, then **squash-merge under your GitHub name**.

That babysit is **not** the full “audit / fix / debug / then merge” bar you just stated. It is closer to: **CI green + local package tests + doctrine greps + a PR comment**, then merge. It rarely opens a fix PR on Denon’s work; it **approves with a checklist**.

---

## What the loop is doing _right now_

| Mode                          | Status                       | What happens                                                                                  |
| ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| Agent product cook            | **DRAINED**                  | Queue empty. Explicit: do **not** invent product.                                             |
| 45m re-check                  | **Designed** in the law file | Re-read `docs/GRIND-LOOP-ACTIVE.md`; if open PRs → babysit; if not → honesty/regression only. |
| Your account on GitHub lately | **Idle since #215**          | Docs high-water only.                                                                         |
| Who is still building         | **Denon**                    | #216 merged by him; spine branches still cooking.                                             |

So if nothing is open: the loop’s job is **almost nothing** — not “merge forever.”

---

## Three things people confuse (keep them separate)

| Layer                          | Who builds                      | Who “reviews”                                                      | Who merges (in practice today)                               |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| **A. Nitro agent product**     | Your AFK cook (when RUNNING)    | Same agent’s light gates + wave audits every few ships             | Your account, after its own PR is green                      |
| **B. Denon spine product**     | Denon / his agents              | **Denon self-audit in PR body** + **your babysit comment** (gates) | Often **your account** (“babysit-merge”)                     |
| **C. Whole-repo peace audits** | Separate mega / wave audit runs | Archive under `docs/audit/…`                                       | Not a merge machine — produces findings + occasional fix PRs |

**Mega-audits happened** (`docs/audit/2026-07-30-afk-cook-mega/`, `…-mega-r2/`). Those are **batch tip audits**, not a per-PR deep design review of every Denon ship that later landed (#201–#216).

---

## Is it “just merging unreviewed stuff?”

**Short answer: it is merging after a _thin_ review, not after _your_ full bar.**

### What babysit _does_ do (evidence on real PRs)

On money PRs (#202 loans, #214 pay) your agent posted a comment then merged within minutes. Typical content:

- CI: Doctrine / Typecheck / Tests / DoD **SUCCESS**
- Local: package tests pass, format, brand, `pnpm gate`, migration reversible
- Money bullets: ledger-client only, no money-as-number for amounts, named gates (e.g. public sandbox refuse)
- Then: “Squash-merging under Denon green-CI + self-audit policy”

Example smell on **#214**: Denon wrote _“Money path. Opened for review, not for a fast merge.”_ Your agent treated that as “do a money checklist,” posted the checklist, and merged **~4 seconds later**. That is **gate review**, not **hold for human/partner design review**.

### What babysit usually does _not_ do

- Deep adversarial redesign of Denon’s approach
- Open a **fix PR** before merge when something is “smelly but green”
- Long debug sessions on his branch unless CI/local is red
- Formal GitHub **Review** (Approve/Request changes) — almost always a **comment + merge**
- Wait for Denon if he asked for review time

### When the loop _did_ more than merge

- **Cook phase:** built product, ran light gates, wave audits A–E, mega-audit r1/r2, tracker honesty, scoreboard updates.
- **Sometimes** on babysit: rebase/conflict resolve, force-push, re-run CI (#209 comment trail). That is **make it mergeable**, not always **re-architect**.

---

## Match against _your_ standard

| Your bar   | Loop today                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Audit      | **Light:** CI + local gates + short doctrine/money comment. **Not** full design audit every PR.  |
| Fix        | Only if red or babysit finds an obvious gate fail; not “I disagree with the design → fix first.” |
| Debug      | When tests/CI fail; not exploratory product debug of green PRs.                                  |
| Then merge | **Yes — merge is the default success path** for green Denon PRs under AFK babysit.               |

So: **you are right to worry.** It is **not** “blind merge with zero checks.” It **is** “auto-merge with automated + checklist review,” which is **weaker** than audit→fix→debug→merge if “audit” means human-grade or full adversarial review.

Repo law (`AGENTS.md`) also says Denon may merge **his own** PRs on green CI + self-audit **without your Approve**. Babysit under your name is an **AFK speed overlay**, not the written asymmetric review story.

---

## What the loop does in one diagram

```
[RUNNING]
  pick NEXT QUEUE item → implement in worktree → light gates → open PR
  → every 3–4 product PRs: wave audit docs
  → merge own green PRs → update GRIND-LOOP high water

[DRAINED]  ← you are here for Nitro product
  every ~45m (if a session still runs):
    open PRs? → babysit (gates + comment + often merge)
    else → doctrine/tracker honesty only; do not invent product
  mega-audit: separate batch job, already ran once (r1+r2)
```

---

## Unspoken needs (deduced)

You care about:

1. **Sleep without panic** — volume while away, but no “fake money / fake done / fake CI.”
2. **Partner trust** — Denon shouldn’t feel you rubber-stamped his money PR against his “not for fast merge.”
3. **Meaning of merge** — green CI ≠ finished thinking; merge = “we’d defend this in court / go-live story.”
4. **Clear modes** — cook vs babysit vs audit are different jobs; one prompt must not collapse them into “merge stuff.”
5. **Compaction survival** — next chat must inherit **honest** high water + rules, not stale #214 / false chain-done.
6. **You never read code** — proof must be: PR link, CI color, one plain comment (“what was checked / what was _not_”).
7. **Stop conditions** — drained means **stop inventing**, not **stop thinking**; money/review-request means **stop merging**.

---

## Enhanced prompts (paste-ready)

### 1) AFK grind — **product cook** (only when Status = RUNNING)

```
AFK GRIND — PRODUCT COOK (Nitro away). You ship product; you do not babysit-merge Denon money.

LAW (tip origin/main, in order):
  1) docs/GRIND-LOOP-ACTIVE.md   — if Status is DRAINED, STOP this prompt; switch to BABYSIT prompt only
  2) docs/GRIND-PLAN-2026-07-30.md
  3) docs/AFK-COOK-SCOREBOARD-2026-07-30.md
  4) live: git fetch · git log origin/main -25 · gh pr list open/merged

HARD RULES:
  - Worktree from origin/main only. Never edit main checkout. Never push main.
  - One service (or one docs concern) per PR.
  - Your bar before YOU merge YOUR PR: audit → fix → debug → prove → then merge.
      audit = doctrine + money path + tests for failure branches you touched
      fix   = no known red / no known lie in tracker for this surface
      debug = failing case reproduced then green; do not merge “should pass”
  - Light gates every PR; wave audit every 3–4 product ships (brand/custody/vendor-shell/tracker + money greps).
  - Never fake CI green. Never mark human-only done. Never invent candles/balances/factory addresses.
  - Never invent Denon product/policy (live rails, multi-asset enum, licences, go-live, counsel).
  - Update GRIND-LOOP-ACTIVE.md before you stop (queue + high water + honest Status).

DO NOT:
  - Merge Denon’s open PRs from this prompt (use BABYSIT prompt; money may be NO-MERGE).
  - Pad ceremony when NEXT QUEUE is empty — set Status DRAINED and stop cooking.

GO: NEXT QUEUE #1 only.
```

### 2) AFK grind — **babysit** (DRAINED or “only merge/check open PRs”)

```
AFK GRIND — BABYSIT ONLY (Nitro away). Default is NOT auto-merge.

LAW: docs/GRIND-LOOP-ACTIVE.md on origin/main first. Live: gh pr list --state open.

FOR EACH OPEN PR, classify:

  CLASS M — MONEY / CUSTODY / LEDGER / PAY / BANK / TRADE SETTLEMENT / WITHDRAW
  CLASS P — PRODUCT SPINE (Denon-authored non-money)
  CLASS N — NITRO / DOCS / STREAM A / TRACKER HONESTY
  CLASS H — HUMAN-ONLY surface (billing, licences, multi-asset rails, kill drill, counsel)

CHECKS (all classes) before any merge decision:
  1) CI: Doctrine + Typecheck + Tests + DoD all SUCCESS (or honest local-green if billing-blocked — never claim Actions green)
  2) Local: touched packages tests + pnpm gate for that service when applicable
  3) Read PR body for self-audit; skim money path claims against doctrine
  4) Post a PR comment: what you ran, what you verified, what you did NOT verify
  5) If PR says "not for a fast merge" / "needs review" / "do not merge" → NO-MERGE. Comment only. Ping Denon in comment.

MERGE POLICY:
  - CLASS M: NO auto-merge under Nitro account. Leave open for Denon merge after his review bar, OR only merge if Denon explicitly comments "merge when green".
  - CLASS P: merge only if CI+local green AND no "hold/review" language AND no unresolved review threads. Prefer Denon self-merge when he is online.
  - CLASS N: you may merge after audit→fix→debug bar on that PR.
  - CLASS H: never mark done; never merge as if human work finished.

IF RED:
  - Do not merge. Either fix on a *your* branch only if scope is clearly Nitro-owned, or comment the failure + leave for author.
  - "Fix" means a real failing proof then green — not vibes.

IF NO OPEN PRS:
  - Optional: brand/custody/vendor-shell/tracker:check on tip; fix only real honesty lies.
  - Update high water if main moved. Do not invent product.
  - Stop. Do not pad.

UNSPOKEN: Nitro wants sleep + partner trust. A green checkbox is not a design review. When unsure → NO-MERGE + plain comment.
```

### 3) One-liner for **new chat** (so compact doesn’t revive rubber-stamp)

```
Grind is DRAINED for product. Do not invent ships. Babysit open PRs with the BABYSIT prompt: money/review-request = NO-MERGE under my account; gates+comment only. Denon merges his money. Update GRIND-LOOP high water if tip moved. Full rules: docs/GRIND-LOOP-WHAT-IT-DOES-AND-PROMPT-FIX-2026-07-30.md
```

### 4) Optional hard rule to put in `AGENTS.md` / grind law (when you want it durable)

```
Nitro agents must not merge Denon money-path PRs unless Denon comments "merge when green".
PR language "not for a fast merge" / "needs review" is a hard stop.
Babysit = verify + comment; merge is a separate privilege.
```

---

## What you should believe after reading this

| Belief                                            | True?                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| Loop only auto-merges, never audits               | **False** — thin audits + past mega/wave audits exist                   |
| Loop always full audit→fix→debug then merge       | **False** — that is your _desired_ bar, not babysit’s default           |
| Right now it is flood-merging unreviewed code     | **False** — no open PRs; product queue drained; Denon self-merged #216  |
| Your name on Denon merges means you deep-reviewed | **False** — usually gates + checklist comment                           |
| Closing a chat guarantees the loop is dead        | **Not guaranteed** — law still describes 45m re-check if a session runs |

---

## Suggested next moves (your call; nothing executed)

1. **Adopt BABYSIT merge policy** (money / “not for fast merge” = no Nitro merge).
2. **Paste enhanced prompts** into `docs/GRIND-LOOP-ACTIVE.md` on a docs PR when you want the law file to match reality.
3. **Tell Denon in one line:** “AFK babysit was checklist+merge; from now money stays his merge.”

No product code was changed in this write.
