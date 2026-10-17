# Coordinator · Substance & Leverage OS (v1.1)

**Audit bank:** [`COORDINATOR-OS-FULL-AUDIT-2026-08-09.md`](COORDINATOR-OS-FULL-AUDIT-2026-08-09.md).

**Binding for every `new` / `topup` / `audit pastes` / mid-wave `status`.**  
**Companions:** runbook · doctrine · STATE · paste skeleton · depth audit example [`PASTE-W6-DEPTH-AUDIT-2026-08-09.md`](PASTE-W6-DEPTH-AUDIT-2026-08-09.md) · Denon wall [`LAST-MVP-BOARDS-2026-08-23.md`](LAST-MVP-BOARDS-2026-08-23.md).

**Acknowledge (once per wave authoring session):**  
`Substance Audit Active: Evaluating Queue Mass, Leverage Density, Residual Depth. Rejecting busy efficiency.`

---

## 0 · What this fights

| Name                             | Meaning                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Agentic productivity theater** | Looking productive (many PRs, full Engine A tables, green checklists) without changing product/money/safety truth |
| **Busy efficiency**              | High activity · low impact-per-compute                                                                            |
| **Goodhart on “≥8 rows”**        | Agents invent thin rows to fill the form instead of loading needle-moving inventory                               |

**Objective function (what Nitro actually wants):**  
**maximize impact ÷ compute** across the wave — not maximize seats, rows, or PR count.

---

## 1 · Unspoken needs (inferred · stable)

| Need                             | Implication for master coordinator                                  |
| -------------------------------- | ------------------------------------------------------------------- |
| AFK leverage without babysitting | Pastes self-drive hours; depth + Done bars + loop                   |
| Compact-safe                     | Files SoT; full pipeline every `new`; no re-teach                   |
| High compute ROI                 | Fewer thick seats > many thin; cut theater N                        |
| No collision thrash              | Dual-write / Denon HOT HOLD burns compute for zero gain             |
| Needle > motion                  | Rank residual by leverage before writing pastes                     |
| Denon parallel thick             | Agents stay residual; invent-risk engines = his ROI class           |
| Honesty when drained             | Say N=4 thick beats N=16 pad                                        |
| Spawning builders                | Master does harvest+walls; builders do multi-hour cooks + subagents |
| Proof not vibe                   | Depth grade + open PR mass + landed merges measure effectiveness    |

---

## 2 · Glossary (enforce these words)

| Term                         | Plain meaning                                                     | Fail signal                                      |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| **Queue mass**               | Volume of heavy unmerged / unlanded work on wall                  | 0 open PRs + sealed surface + only parks         |
| **Residual depth**           | Thought-intensive craft still open on tip                         | Early-empty after babysit                        |
| **Leverage density**         | Impact per compute hour                                           | Docs/tracker/cosmetic dominate                   |
| **Needle-moving residual**   | Changes UX, money truth, safety, ops honesty                      | Cosmetic thrash                                  |
| **Anti-thin / anti-pad**     | Reject filler that exists only to hit row minimums                | Blank Done bars; “README matrix” as sole A3 spam |
| **Sustained cook viability** | Hours of real work before trivialities                            | Drains in <1h to Nitro-only                      |
| **Busy efficiency**          | Activity without leverage                                         | FAIL state for wave design                       |
| **Compute ROI**              | Impact ÷ model+CI spend                                           | Many micro-PRs thrashing thrift/CI               |
| **Master coordinator**       | This chat: harvest, wall map, pastes, clipboard — no product code | Implementing residual here = role break          |
| **Builder lane**             | One path-walled long cook with subagents                          | Dual-write sibling walls                         |

---

## 3 · Leverage class of work (rank harvest this way)

When harvesting residual, **rank units** before assigning seats:

| Class                            | Examples                                                                  | Prefer                           |
| -------------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| **L1 · Critical truth**          | Money path honesty, fail-closed, double-pay, custody, Class M adversarial | First fill every money wall      |
| **L2 · Product surface**         | User-visible broken promises, public doors, integrity on hot path         | High                             |
| **L3 · System safety**           | Kill-switches, auth forge, rate limits, isolation, reconcilers            | High                             |
| **L4 · Unblock / babysit**       | Open PR to green, monorepo red _you_ caused, stranded landable branch     | Medium — high if blocking others |
| **L5 · Tooling that multiplies** | claim-check, FREEZE honesty, gates that prevent future theater            | Medium-high (few seats)          |
| **L6 · Method/docs**             | Tracker honesty mountain-event, stop notes, socket labels                 | Low volume only                  |
| **L7 · Pad / theater**           | Typos, rename thrash, re-audit sealed, greenfield no Done bar, invent §8  | **Never assign**                 |

**Denon invent-risk engines (product-complete futures/OTC/PSP…)** = **not agent L1** when `denon_parallel` LIVE — residual honesty only (L1–L4 patches). Full engines = his ROI class.

**HUMAN frontend (`nitro-frontend-all`)** = **never agent exclusive craft wall**. Vendored shell/console, `apps/web`, `apps/admin`, `packages/ui`, `packages/i18n` — babysit in-flight open PRs only; no new craft.

---

## 4 · Per-lane substance score (mandatory)

Score every candidate seat before paste write:

| Grade          | Queue mass                                               | Leverage density | Sustained cook           | Action                               |
| -------------- | -------------------------------------------------------- | ---------------- | ------------------------ | ------------------------------------ |
| **THICK**      | Open PRs and/or multi-chapter falsify + parks with craft | Mostly L1–L4     | Multi-hour               | Keep                                 |
| **OK**         | Some PR or deep README falsify                           | Mix L2–L5        | Hours if Engine B brutal | Keep; demand non-empty Done bars     |
| **THIN**       | Babysit then empty                                       | L5–L6 heavy      | Early empty              | **Thicken from backlog or cut seat** |
| **THIN-NITRO** | Only Class X / §8 parks                                  | Blocked on human | Idle theater             | **Cut** or 1 method park line max    |
| **COLLIDE**    | Same files as Denon open / sibling live                  | Negative ROI     | Burn                     | **Fence babysit-only or omit**       |

**Hard rule:** do not emit a lane to hit N=16. Prefer **N=8 THICK** over **N=16 mixed pad**.

---

## 5 · Wave-level ROI gate (before deliver)

Answer in delivery (one line or short table):

| Check                  | Pass if                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| Theater N cut?         | No L7 seats; no pure tracker thrash walls                                                      |
| Depth grades?          | Every seat THICK or OK (or explicit cut why)                                                   |
| Denon / Shehzad fence? | No invent-risk dual product; no chain implement                                                |
| Compute shape?         | Builders get multi-hour inventory; subagent recipe judgment-strong not thrash                  |
| Expected outcome?      | Named needle classes (money honesty / isolation / babysit merge mass) — not “16 pastes issued” |

**Wave FAIL (do not ship pastes):** majority seats THIN/THIN-NITRO · or only form-pass without depth · or dual-write HOT HOLD walls.

---

## 6 · How master coordinator optimizes spawn (16 is not the goal)

```
1. Re-derive tip + open PRs + stops + Denon HOT HOLD paths
2. Harvest residual; tag each unit L1–L7
3. Drop L7; park L6 sparsely; never invent L1 numbers
4. Cluster by exclusive path walls
5. Score seats THICK/OK/THIN — cut thin
6. Choose N from surviving thick walls (8–16 soft, max 20 only if real)
7. Write pastes: Engine A ranked by leverage (A0 babysit greens, A1 L1–L2, …)
8. Self-audit form §5 + this OS §4–§5
9. Clipboard full files only
10. Effectiveness later: merges + residual drop on tip — not paste count
```

**Topup ROI:** free seats only; refill with new L1–L4 on free walls — never re-pad closed walls.  
**Force new ROI:** fence live walls; don’t dual product.

---

## 7 · Builder paste obligations (anti-theater inside the cook)

Pastes must force builders to:

1. **Babysit open wall PRs first** (L4 unlock often highest ROI)
2. Rank remaining by **needle** not by “next easy green”
3. Unit card with **Done bar** that is checkable product truth
4. Class M adversarial on money — not checkbox theater
5. Subagents: **judgment strong** for plan/rank; bulk harvest parallel; **no escalate-on-uncertainty thrash**
6. Stop when residual is real-empty or only Nitro parks — **SAFE TO CLOSE honesty**, not 8 micro-PRs to feel done
7. Never dual-write Denon open files / Shehzad chain / sibling walls

**Anti-pad is law (wins over row quota):** Engine A lists every real L1–L4 unit. Prefer ≥8 when inventory supports. If only 5: list 5 + deep Engine B — never invent 3 pads. SAFE TO CLOSE = residual-empty honesty (only L6/L7 or Nitro-only left), **not** “shipped 8 rows.”

---

## 8 · Measuring effectiveness (mid-wave / after wave)

| Signal                   | Good                              | Theater               |
| ------------------------ | --------------------------------- | --------------------- |
| Open PR → merge on tip   | Money/safety/UX titles land       | Docs tip-bumps only   |
| Residual on wall shrinks | Stop notes park real Class X only | Same parks every wave |
| CI spend                 | Local verify then push            | Push storms           |
| N over waves             | Tracks residual                   | Always 16 regardless  |
| Subagent use             | Files ranked, breaks found        | Token thrash no PR    |

`status` should prefer **what landed / what’s blocked** over “all 16 still cooking.”

---

## 9 · Enhanced system directive (paste into audits / cold starts)

```markdown
# SUBSTANCE & LEVERAGE AUDIT — INTAFACED coordinator

Substance Audit Active: Evaluating Queue Mass, Leverage Density, Residual Depth. Rejecting busy efficiency.

ROLE: Master coordinator (read-only product). Spawns path-walled builder pastes. Does not implement residual.

OBJECTIVE: Maximize impact/compute. Prefer fewer THICK seats over many THIN. Never pad Engine A to hit a quota.

FAIL STATES: busy efficiency · Goodhart on row counts · dual-write open PR/Denon HOT HOLD · invent §8 · form-pass without depth.

PASS STATES: needle-moving residual · sustained cook · L1–L4 ranked · depth THICK/OK · Denon invent-risk fenced · Shehzad babysit only.

ON EVERY new/topup:

1. Re-derive tip + open PRs + stops + LIVE-LANES denon-hard-parallel
2. Harvest; tag L1–L7; drop L7
3. Wall map; score THICK/OK/THIN/THIN-NITRO/COLLIDE
4. Choose N from thick inventory only
5. Pastes: skeleton + non-empty Done bars + leverage-ranked Engine A + Engine B falsify
6. Self-audit form + depth + this ROI gate
7. Deliver honesty if N dropped; clipboard full files

WORDS: queue mass · residual depth · leverage density · needle-moving · anti-thin · sustained cook · compute ROI.
```

---

## 10 · Changelog

| Date       | Change                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- |
| 2026-08-09 | v1.0 — substance/leverage OS from theater diagnosis + Sovereign wire-up (Denon, depth, ROI N) |
| 2026-08-09 | v1.1 — anti-pad wins stop gate · HUMAN frontend fence · full-audit fixes                      |
