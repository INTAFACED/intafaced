> **Not current rules (2026-10-18).** Kept as history. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# Frontend AFK Autonomous Campaign — plan, architect, execute

**Status:** ACTIVE standing order · 2026-08-02  
**Trigger:** Nitro AFK / “don’t stop / don’t ask continue / no human in loop”  
**Companions:** AOS · residual-register.json · GO-READY · NITRO-SESSION-PROMPT (AFK block)  
**Success:** cold agent after `/compact` resumes from residual alone; no “waiting for Nitro” except Class X / taste / real money rails.

---

## 0 · What failed before (learned from prior Grok Stream A sessions)

| Failure mode           | How it showed up                                               | Permanent combat                                                                                                        |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Continue-loop**      | Agent ends each slice waiting for human “continue”             | Standing order: drain residual until empty of `afk_safe` open items or hard kill (below)                                |
| **Compaction amnesia** | Re-plan from zero; forget tip residual                         | Law + residual on `origin/main`; preflight; this doc; stamp tip SHA every wave                                          |
| **Ship-asks**          | Old session prompt “no commit unless I ask”                    | **AFK override:** Class N Stream A ship authorized (see prompt)                                                         |
| **Human-gated queue**  | P0.3/auth Orca / money scorecard parked as “next” forever      | Split residual into **afk_safe** vs **human_or_fleet**; never stall on the latter                                       |
| **Thin residual**      | Queue looks “done” while invent still in Invite/Lab/components | Expand register with **discovered** surfaces; re-scan each wave                                                         |
| **CI thrash**          | format:check on historical docs                                | Prettier write before push; thrift: local check, batch                                                                  |
| **Proof theater**      | Claim craft without eyes                                       | Orca when available; if Orca closed → honesty still ships with dual-book text + residual honesty; never invent balances |
| **One-PR hero**        | Big branch dies                                                | One residual id per PR; Class N merge; next id immediately                                                              |

---

## 1 · Standing order (this is the law while AFK)

1. **Do not stop** for “continue.” End-of-turn only when: residual has zero `afk_safe` open/partial **or** kill condition fires. Prefer `pnpm swarm:freeze` + `pnpm swarm:next` for the free board (companion to residual-print; anti-under-spawn).
2. **Do not wait** for Nitro for: worktrees, git, PR, CI poll, squash-merge Class N, residual stamps, preflight, brand-scan, goldens.
3. **Do not invent** money, balances, live books, or “improved” without scorecard row.
4. **Do not touch** order-route, futures, Stream B services, Denon money branches.
5. **Park, do not stall:** anything needing fleet auth, signed-in Orca, counsel, or palette taste → status `blocked` + `blocker` named; pick next `afk_safe`.
6. **Class N merge** when CI green (doctrine + tests + typecheck + DoD). No Nitro Approve.
7. **After merge:** update residual same turn; open next worktree from tip; next id.
8. **Compaction:** re-orient = `pnpm frontend:preflight` + `pnpm frontend:residual` + this file + AOS. Never re-plan from chat memory alone.

### Kill conditions (stop the run — write residual note, do not fake progress)

- Preflight fails and cannot fix in one LAW PR
- 3 consecutive CRAFT PRs with zero user-visible honesty/craft delta
- Money path would require inventing balances or seed fixtures
- Open PR already owns the same product file paths (collision)
- Main red for reasons outside Stream A and unfixable without Stream B

---

## 2 · Architecture (roles + loop)

```
              ┌──────────────────────────────────────┐
              │ residual-register.json (machine SoT) │
              │ afk_safe · human_or_fleet · priority │
              └──────────────────┬───────────────────┘
                                 │
     ┌───────────────────────────┼───────────────────────────┐
     ▼                           ▼                           ▼
 ORIENT                     SLICE LOOP                    PROOF
 fetch tip · preflight      gap → implement →             goldens · brand
 residual print             refs · critique ·             CI · Class N
 collision gh pr list       PR · poll · merge             residual stamp
                                 │
                                 └──────► next afk_safe id (no ask)
```

| Role         | Who                                    | When AFK                               |
| ------------ | -------------------------------------- | -------------------------------------- |
| Orchestrator | Session model                          | Always; never idle on human gate       |
| Implementer  | Session or subagent                    | One residual id                        |
| Reviewer     | Subagent or solo checklist             | Every PR body self-audit               |
| Eyes         | Orca if open; else honest residual     | Prefer Orca; never block queue         |
| Regression   | ui:proof when host allows; CI optional | P0.4 not a hard stop for honesty craft |

---

## 3 · Spec — what “done enough” means without Nitro eyes

| Surface class | Done when                                                                         | Not done                         |
| ------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| **HONESTY**   | Dual-book / fail≠empty / no invent numbers or contact URLs; golden if pure helper | Looks pretty only                |
| **CRAFT**     | Visible 1440 delta or named density rule; steal-lines + critique in refs          | Token rename only                |
| **LAW**       | Residual + prompts + AOS coherent; preflight green                                | Docs that invent “shipped craft” |
| **PROOF**     | Scorecard row or ui:proof green                                                   | Claiming Dim6=3 without measure  |

**Free hands:** if a polish PR cannot answer “what does Nitro see differently at 1440?” — do not open it.

---

## 4 · Decomposed work units (AFK-safe queue seed)

Machine ids live in residual-register. Human map:

### Wave 0 — always first each session

| ID         | Work                                  |
| ---------- | ------------------------------------- |
| P0.1       | Tip worktree (done process)           |
| AFK-ORIENT | preflight + residual + collision list |

### Wave HONESTY (no fleet)

| ID              | Surface                                           | Problem                                    |
| --------------- | ------------------------------------------------- | ------------------------------------------ |
| AFK-INVITE      | Invite.vue                                        | Hardcoded `0.001 BTC`, invent `promotion@` |
| AFK-ENVELOPE    | Envelope.vue                                      | Red-envelope path honesty if empty/fail    |
| AFK-CTC         | Ctc.vue                                           | Dual-book / fail honesty on C2C            |
| AFK-ACTIVITY    | Activity*.vue                                     | Attend amount invent zeros                 |
| AFK-UC-COMP     | uc components (PayDividends, Innovation*, Record) | empty≠zero adoption                        |
| AFK-IDENT       | IdentBusiness.vue                                 | placeholder invent                         |
| AFK-LAB-PASS    | intafaced/*                                       | dual-book pass if any invent yield/APY     |
| AFK-INDEX       | Index.vue                                         | residual honesty polish if gaps            |
| AFK-APPDOWNLOAD | AppDownload if invent stores                      |

### Wave CRAFT (no fleet)

| ID              | Surface                                  |
| --------------- | ---------------------------------------- |
| AFK-CMDK-ROUTES | Expand cmd catalog from real router only |
| AFK-FOOTER      | Terminal footer hide consistency         |
| AFK-MOBILE-REG  | MobileRegister shell density vs Login    |
| AFK-HELP-DETAIL | HelpDetail sidebar honesty               |
| AFK-WHITEPAPER  | WhitePaper honesty shell                 |

### Wave TOOLS (no Nitro)

| ID            | Work                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| P0.4          | ui:proof green where Chromium lives (CI job or unrestricted host) — **try, never block honesty** |
| AFK-PREFLIGHT | Harden preflight for AFK flags                                                                   |
| AFK-FORMAT    | Keep format:check green on touched docs                                                          |

### Wave PARKED (do not pick while AFK)

| ID                            | Why                                    |
| ----------------------------- | -------------------------------------- |
| P0.3 auth money Orca          | Needs signed-in session                |
| META-SCORECARD full Dim claim | Needs auth eyes                        |
| B11 entry line                | Needs fleet positions                  |
| C-LWC                         | After B DoD + A6                       |
| B15                           | Waived                                 |
| ADMIN A1 ledger reconcile     | Money-adjacent; separate audit program |
| order-route / futures         | Explicit ban                           |

---

## 5 · Execute protocol (every slice — no shortcuts)

```text
1. residual-print → pick lowest priority with status open|partial AND afk_safe=true AND not blocked
2. gh pr list --state open --json files → collision? skip id
3. worktree from origin/main · branch feat/app-<id>
4. mkdir docs/refs/<id>/ · gap-audit · steal-lines · critique
5. implement surgical · goldens if pure js
6. brand-scan / prettier check on touched
7. commit · push · PR (Stream A body) · poll CI · squash-merge Class N
8. residual stamp tip_note + item status · tip_sha
9. GOTO 1  (do not message Nitro for permission)
```

Subagents: use for bulk scan (invent strings), parallel file inventory, and PR review — **judgment + merge stay orchestrator**.

---

## 6 · Enhanced session prompt (paste)

Canonical paste lives in `docs/NITRO-SESSION-PROMPT.md` § **AFK / full autonomous**.  
Cold agents: if residual `tip_note` contains `AFK-ACTIVE`, treat AFK block as mandatory override of “no ship without ask.”

---

## 7 · Relation to AOS

This campaign **does not replace AOS** — it fills the hole AOS left:  
“what if residual only has human-gated items and the human is gone?”  
Answer: expand `afk_safe` inventory, park human items, keep shipping.

---

## 8 · Re-plan cadence (autonomous)

Every **5 merges** or **any kill near-miss**:

1. Re-scan vendor shell for invent patterns (grep campaign)
2. Append new residual ids (never delete history; mark done)
3. Re-stamp GO-READY queue truth
4. Continue

Do **not** re-open Wave C / order-route from re-plan.

---

_If this file is missing from tip, AFK autonomy is not authorized — restore via LAW PR first._
