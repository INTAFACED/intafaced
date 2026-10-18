# Frontend Autonomous Operating System (AOS) — architecture

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**[HISTORY 2026-09-01]** Not day-to-day law. Live: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md) §20.1 Codex vs Grok.

**Status:** HARDENED · 2026-08-02  
**Replaces as day-to-day law:** thin “ship loop” continue briefs alone  
**Companions:** methodology v3.1 · plan v3.1 · Design Bar · OPS-NOW · level recovery · this AOS  
**Tip re-derive:** stamp `origin/main` SHA at every wave start

---

## 0 · Implicit requirement inference (why this exists)

| You said (surface)                        | What it actually requires (inferred)                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| “Fully autonomous without me in the loop” | Machine-checkable gates; Nitro only for taste/Class X; no “please open CI”                                              |
| “Afraid you’re not at level”              | Stop treating CI green as craft quality; restore scorecard + Orca + critique                                            |
| “Session compaction provenance”           | Law + residual + scorecard on **GitHub tip**; scripts that fail if law missing                                          |
| “Tools we were supposed to use”           | Wire Orca, ui:proof, brand-scan, gap-audit, impeccable/design-taste, steal lines into **required** preflight, not prose |
| “Bottlenecks”                             | Name each bottleneck + autonomous combat (not hope)                                                                     |
| “Not lazy / plan completeness”            | Every Wave B/C/Admin item has status: done / partial / open / blocked / waived + proof path                             |
| “Research and reason ourselves”           | Catalog + L1 + LWC docs before inventing; no “wait for Nitro” on solvable forks                                         |
| “Won’t matter right?”                     | Bias toward **more complete bar**, never toward smaller work to look efficient                                          |

**Success condition for AOS:** a cold agent after `/compact` runs `pnpm frontend:preflight`, reads residual register, and cannot ship under-level without a **deliberate, named waiver**.

---

## 1 · System architecture (decomposition)

```
                    ┌─────────────────────────────┐
                    │  LAW (docs on origin/main)   │
                    │  methodology · plan · bar    │
                    │  OPS · claim · color · AOS   │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  RESIDUAL REGISTER (JSON)    │
                    │  every B/C/Admin/dim item    │
                    │  status + proof + owner      │
                    └──────────────┬──────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
   PREFLIGHT                 SLICE LOOP                  PROOF LAYER
   frontend:preflight        gap-audit → code →          Orca primary
   law files · tip SHA       steal lines → critique      ui:proof matrix
   collision · scorecard     brand-scan → CI             scorecard re-row
         │                         │                         │
         └─────────────────────────┴─────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  MERGE Class N + SoT update │
                    │  residual register refresh  │
                    └─────────────────────────────┘
```

### Roles (no human bottleneck except named)

| Role                         | Who                                                             | Output                                     |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| **Implementer**              | Session model (this chat class)                                 | Diff + gap-audit + PR body                 |
| **Certifier craft**          | Same session **or** fresh subagent with impeccable/design-taste | Critique note in PR                        |
| **Certifier money-adjacent** | Second pass (subagent or explicit checklist if solo)            | Self-audit block                           |
| **Eyes**                     | Orca embedded browser                                           | `docs/styleboard/shots/` or PR attachments |
| **Regression net**           | `pnpm ui:proof` (+ auth pass when fleet)                        | PROOF.md / report                          |
| **Doctrine**                 | brand-scan, vendor-shell-scan                                   | CI + local preflight                       |
| **Operator**                 | Nitro                                                           | Palette re-pick · taste · Class X only     |

---

## 2 · Bottlenecks → autonomous combat

| Bottleneck                       | How it kills level               | Combat (autonomous)                                                                                 |
| -------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Compaction**                   | Law forgotten; residual invented | Law on tip; `frontend:preflight` fails if missing; residual JSON                                    |
| **CI green theater**             | Merges without craft proof       | PR template Stream A block required; preflight warns if no Orca path                                |
| **Docs-only skip CI**            | Format drift / silent skip       | Touch shell or accept docs-only only for law                                                        |
| **No second machine for review** | Self-certify money               | Solo mode: mandatory money checklist + “second-pass” section; prefer spawn certifier when available |
| **Orca closed**                  | Cannot prove UI                  | Preflight checks `orca status` when `ORCA_REQUIRED=1` (default on craft)                            |
| **Fleet down**                   | Cannot auth-money proof          | Honest empty Orca + never invent; residual “fleet-blocked” status                                   |
| **LIVE-LANES thrash**            | Collision edits                  | Collision check via `gh pr list` paths; skip LIVE-LANES if order-route owns it                      |
| **Scorecard abandoned**          | Unfalsifiable “better”           | Residual register marks B DoD blocked until re-score row exists                                     |
| **Skill fatigue**                | Skip impeccable                  | Craft slices must write `docs/refs/<slice>/critique.md` or preflight fails                          |
| **Under-build**                  | Minimum delta after free-hands   | Free-hands line + “visible 1440 change?” for polish PRs                                             |
| **Parallel agents**              | Double-build Exchange.vue        | Preflight lists open `feat/app-*` / `feat/ui-*` heads                                               |
| **Time pressure**                | Thin recovery docs               | AOS requires architecture + register, not 3-min checklist                                           |

---

## 3 · Slice types (architected work units)

| Type        | Examples                              | Must use                                                                    |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------- |
| **HONESTY** | empty≠zero, locks, dual-book          | Gap-audit · gates 4/12/18/19 · Orca fail state · money second-pass          |
| **CRAFT**   | density, tokens, watchlist, keyboard  | Steal lines · impeccable/design-taste · before/after crop · free-hands line |
| **PROOF**   | scorecard, ui:proof expand, Orca pack | Non-implementer preferred · no product feature claim                        |
| **LAW**     | methodology, AOS, residual            | Provenance only · no “shipped craft” language                               |
| **ADMIN**   | Admin-0 inventory                     | Separate branch prefix · not Exchange.vue                                   |
| **WAVE_C**  | LWC v5 panes                          | A6 plan gates · strong model · no invent API                                |

One type per PR. If title needs “and”, split (AGENTS).

---

## 4 · Tools wiring (required path)

| Tool              | When                                            | Command / artifact                                           |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| **preflight**     | Every session start + before PR                 | `pnpm frontend:preflight`                                    |
| **ui:boot**       | Before Orca/ui:proof                            | `pnpm ui:boot` (Node 18)                                     |
| **Orca**          | Every HONESTY/CRAFT                             | `orca status` · goto · screenshot → `docs/styleboard/shots/` |
| **ui:proof**      | Before claiming Wave A DoD / after honesty bulk | `pnpm ui:proof`                                              |
| **ui:proof:auth** | When fleet up · never seed money                | `pnpm ui:proof:auth`                                         |
| **brand-scan**    | Local + CI                                      | `pnpm scan:brand`                                            |
| **gap-audit**     | Every slice start                               | Append row to residual JSON + markdown gap file              |
| **steal lines**   | Every CRAFT                                     | `docs/refs/<slice>/steal-lines.md`                           |
| **impeccable**    | Every CRAFT (or design-taste)                   | `docs/refs/<slice>/critique.md`                              |
| **scorecard**     | After material craft batch                      | New section in scorecard live file                           |
| **Class N merge** | When gates green                                | squash-merge · update residual                               |

### Critique skill rule (anti-double-taste)

- Product desk/money → **impeccable** lead
- Marketing landing → design-taste
- **Never both leading** (leverage pack)

---

## 5 · Proof artifact layout

```
docs/refs/<slice-id>/
  steal-lines.md      # 5 lines: From X we take / we do not take
  critique.md         # impeccable or design-taste findings
  proof-desk.png      # Orca crop 1440
  proof-money.png     # optional
  gap-audit.md        # tip inventory + decision rebuild|keep|replace
```

`docs/refs/_template/` holds empty templates. Large PNGs may be gitignored later; PR must still link proof path or attach.

---

## 6 · Residual register (source of truth for completeness)

Machine file: `tooling/frontend/residual-register.json`  
Human view: regenerate via `pnpm frontend:residual` (prints table).

**Status enum:** `done` | `partial` | `open` | `blocked` | `waived`

Every item must have: `id`, `wave`, `status`, `evidence` (PR or path), `proof_missing`, `next_action`, `blocker` (if any).

Agents **must not invent “done”** without evidence field non-empty.

---

## 7 · Definition of “go ready” (operator)

Nitro says **go** when:

1. AOS + residual register + preflight are on **origin/main**
2. He keeps Orca open
3. He accepts agents will spend time on **proof and critique**, not only features

After go, agents do **not** ask which B item — residual register priority order drives work.

---

## 8 · Priority queue (autonomous after go)

1. **PROOF-1** Scorecard re-measure (dims 1–24 gates) + Orca pack
2. **CRAFT-CRIT** Impeccable on Exchange + MoneyIndex + Withdraw → fix P0 findings only
3. **B residual by register priority** (⌘K / deep B3 / complete B5 / full B4…)
4. **Admin-0** inventory (separate worktree)
5. **Wave C** only when A6 gates + residual B DoD not blocking

---

## 9 · Failure modes (kill the run)

| Symptom                                           | Kill action                                        |
| ------------------------------------------------- | -------------------------------------------------- |
| Preflight fails law missing                       | Stop; PR law first                                 |
| 3 consecutive CRAFT PRs with no 1440 visual delta | Stop polish theater; escalate taste or re-baseline |
| Money screen proof uses fixture balances          | Reject PR (doctrine)                               |
| Open PR already owns same Exchange path           | Wait / stack / different surface                   |
| Scorecard claim without numbers                   | Strip claim from PR                                |

---

## 10 · Relation to older recovery docs

| Doc                 | Role after AOS                                   |
| ------------------- | ------------------------------------------------ |
| LEVEL-RECOVERY      | Historical hole-poke + first bar definition      |
| GO-READY-BRIEF      | Short paste — **points here**                    |
| AUTONOMOUS-CONTINUE | Superseded for day-to-day by AOS + residual JSON |
| STATE-OF-TRUTH      | Live status only; links AOS                      |

---

_Architecture is incomplete if residual-register.json or frontend:preflight is missing from tip._
