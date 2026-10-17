# Full Audit Program — A through E (Nitro green-light gate)

**Status:** **CLOSED on main** 2026-07-29 — #80 + #81 merged (`88e5e33`).  
**Living floor:** [`PEACE-OF-MIND-AUDIT-CURRENT.md`](PEACE-OF-MIND-AUDIT-CURRENT.md) · next Denon waves: [`WAVE-AUDIT.md`](WAVE-AUDIT.md)  
**Date:** 2026-07-29  
**Audience:** Nitro (control) · executing agents (law)  
**Claim tags:** `[VERIFIED 2026-07-29]` program complete; do not re-open A→E unless main is on fire

This file is **method history**. New chats: orient from START-HERE + PEACE-OF-MIND, not this program as an open job.

---

## 0 · One-sentence purpose

Make the repo **trustworthy under Denon’s speed**: map what exists, adversarially prove what can lose money or trust, fix what must be fixed, leave a peace-of-mind scoreboard Nitro can re-open without reading code, and install a standing wave-audit loop for the next time Denon ships.

---

## 1 · Enhanced prompts (canonical)

**Wave-1 (historical — already run):** original A→E brief that produced PR #80.  
**Wave-2 (use this):** paste [`HANDOVER-AUDIT-V2-PASTE.md`](HANDOVER-AUDIT-V2-PASTE.md) — residual P1 money + proof upgrades (maker-checker, L0 machine, property tests, cheat-diff).  
**After Denon ships again:** [`WAVE-AUDIT.md`](WAVE-AUDIT.md) only.

Patched full-program method upgrades live in meta-audit section 8 of [`PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md`](PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md); V2 absorbs them without re-archaeology.

---

## 2 · Unspoken needs (deduced — plan must satisfy these)

| Unspoken need                             | How the program answers it                                              |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Control without literacy                  | One scoreboard: systems · risk · proof · fix status — no code           |
| Not be the bottleneck                     | Autonomy defaults + tiny escalation whitelist                           |
| Catch vibe-coder failure modes            | Explicit layers for auth, money, deploy, false-green, honesty-of-done   |
| Trust after self-merged PRs               | Post-merge adversarial audit, not “CI was green once”                   |
| Survive chat compact / multi-session      | Durable docs + claim-tags + entry-chain links                           |
| Don’t drift mid-execution                 | Phased gates, frozen scope baseline SHA, anti-drift checklist           |
| Future Denon waves                        | Phase E standing delta audit, not one-off heroics                       |
| Real platform now, not libraries          | Include edge, mount, deploy, terminal, money path — not only svc cores  |
| Cost is not the limit; waste is           | Parallel judgment where independent; no 50 agents on vendor screenshots |
| Peace of mind is the product of the audit | Phase C is a first-class deliverable, not an afterthought               |

---

## 3 · Ground truth at plan time `[VERIFIED 2026-07-29]`

| Fact                     | Detail                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Local `main`             | Behind origin by **34 commits** (will re-count at execution start)                                              |
| Latest origin tip (prep) | `a19e337` — vendor platform #73                                                                                 |
| Open PRs                 | **0** — all merged                                                                                              |
| CI after #73             | **Red**: brand scan (Doctrine §0.7) + format:check failed; **tests job green**; DoD skipped after doctrine fail |
| Pattern already visible  | Ship → discover open auth / wrong ports / missing docker → hotpatch same day                                    |
| Stale orientation        | `docs/START-HERE.md` / STATUS still describe pre-mount world                                                    |
| Local noise              | Untracked July-27 graph/audit scratch docs — **not** the floor for this program                                 |
| Collab rule              | Denon may self-merge; Nitro’s control = post-merge audit + fix queue                                            |

**Implication:** “Full audit” is justified. Floor is **GitHub `main` at program start SHA**, not local dirty checkout, not July-27 peace-of-mind.

---

## 4 · What “doing this right” means

### Right

1. **Frozen baseline** — record `origin/main` SHA at T0; all findings cite that SHA.
2. **Risk-first completeness** — every _system that can lose money or trust_ is named and judged; not every line of every file.
3. **Proof over narrative** — finding = evidence path + how to re-check; no vibe.
4. **Fail closed on money/auth** — unverified claim stays open.
5. **Fix what we can prove** — P0/P1 with doctrine backing ship without Nitro.
6. **One home per fact** — peace-of-mind doc is the scoreboard; START-HERE updated; no duplicate status novels.
7. **Standing loop** — Phase E so the next wave does not require reinventing this.

### Wrong (explicit anti-patterns)

- Full line archaeology of `vendor/` media dumps
- Rebuilding services “properly” from scratch
- Asking Nitro “should we use worktrees?” / “should we run verify?”
- Claiming done because CI was green on an earlier PR
- One mega-agent that “reads the whole monorepo” and hallucinates coverage
- Fixing cosmetics while money doors stay open
- Messaging Denon mid-audit without Nitro ask

---

## 5 · Architecture of the program

```
                    ┌─────────────────────────┐
                    │  ORCHESTRATOR (this chat)│
                    │  owns scope, proof, docs │
                    │  merges findings, fixes  │
                    └───────────┬─────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
   MACHINE TRUTH          PARALLEL LAYERS         SYNTHESIS
   worktree @ SHA         (read-only agents)      peace-of-mind
   pnpm verify / CI       money · auth · doctrine scoreboard
   platform smoke?        deploy · plane · honesty + ranked queue
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │  ADVERSARIAL VERIFY     │
                    │  2nd pass on P0/P1      │
                    │  fail closed            │
                    └───────────┬─────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │  FIX SPRINT (worktree)  │
                    │  P0 → P1 → re-verify    │
                    │  PR(s) under operator   │
                    └───────────┬─────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │  PHASE E STANDING LOOP  │
                    │  wave-audit workflow    │
                    └─────────────────────────┘
```

### Agent / workflow routing (spend where judgment lives)

| Stage                           | Mode                   | Model posture         | Notes                            |
| ------------------------------- | ---------------------- | --------------------- | -------------------------------- |
| Inventory / file maps / PR list | Mechanical             | Cheap / fast OK       | Structured lists only            |
| Doctrine, money path, auth      | Judgment               | Strong session model  | No silent downgrade              |
| Adversarial verify findings     | Judgment               | Strong                | Independent evidence             |
| Deploy compose/ports            | Mixed                  | Strong for root cause | Easy to false-fix                |
| Vendor risk summary             | Judgment               | Strong                | Strategic rec + safe default     |
| Format/brand CI red             | Mechanical + small fix | Fast then verify      | Already partially known          |
| Synthesis to Nitro doc          | Judgment               | Strong                | Decision altitude                |
| Fix implementation              | Surgical               | Strong                | One concern per PR when possible |

**Workflows to author at execution (after green light):**

1. `denon-wave-audit` — delta from baseline SHA → layer fan-out → verified findings JSON
2. `finding-adversarial-verify` — panel of skeptics, fail closed
3. (Optional) `fix-queue-ship` — only after human/orchestrator selects queue; not fully autonomous merge to main without CI green

Reusable scripts live under `.grok/workflows/` when saved.

**Second model subscription:** use for long parallel judgment panels and verify; session orchestrator keeps scope, anti-drift, Nitro-facing scoreboard, git/PR operator loop.

---

## 6 · Phases A → E (complete decomposition)

### Phase A — Ground truth (no product fixes yet)

**Goals**

- Clean worktree at `origin/main` (or `pnpm wt` equivalent) — **never** dirty main checkout
- Record `BASELINE_SHA`, date, open PR count, CI conclusions
- Run `pnpm verify` (or closest honest subset if env missing) and capture output
- Explain current CI red in plain language (prep already: brand + format after #73; tests green)
- Build **system inventory**: every service, app, package, vendor, deploy unit — one line each

**Deliverables**

- `docs/audit/2026-07-29/00-BASELINE.md` — SHA, commands run, results
- `docs/audit/2026-07-29/01-INVENTORY.md` — full named system set

**Exit gate A:** Inventory names every system on main; baseline SHA frozen; machine truth recorded even if red.

---

### Phase B — Adversarial multi-layer audit (main spend)

Each layer produces structured findings:

```
id, layer, system, title, severity (P0|P1|P2|P3),
evidence (path/PR/command), doctrine_ref if any,
repro, blast_radius, fix_shape, confidence
```

| Layer ID | Name                             | What “complete” means                                                                                                                                           |
| -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1       | **Doctrine / money law**         | Every hard prohibition in AGENT_PROTOCOL checked for violations on main; recipes vs inline posts; float money; cross-service SQL; Protocol write-ledger imports |
| L2       | **Auth & principal**             | Every public procedure / unauthenticated route; edge principal; ownership checks; matching/order write surface; ledger.post auth (history of bugs)              |
| L3       | **Money paths E2E**              | Deposit, withdrawal, holds (purpose-keyed), trade fill → ledger, pay webhook, freeze, P2P escrow — crash-midway stranding question                              |
| L4       | **Plane split**                  | Fiat vs Protocol; “provably non-custodial” claims on DEX/protocol; no custody bleed                                                                             |
| L5       | **Deploy / edge / startability** | compose, Dockerfile, ports, secrets, upstream URLs, `platform:up` — known hotpatch class                                                                        |
| L6       | **API mount honesty**            | What is actually mounted behind edge vs dead code; routers that claim live                                                                                      |
| L7       | **Web / terminal / WS**          | Live wiring claims; unauth depth; plane switch DEX/CEX; no secret leak to client                                                                                |
| L8       | **Tracker / done honesty**       | features.mjs vs reality; false “done”; CI honesty of DoD                                                                                                        |
| L9       | **Vendor (#73) risk**            | Why present, how wired, brand-scan impact, license, isolation, **recommendation + safe default**                                                                |
| L10      | **Historical money services**    | Trade, matching, pay, p2p, bank, token, identity, ledger, protocol, agents — not only last wave                                                                 |
| L11      | **Regression of known bugs**     | Re-check fixed issues: #32 yield/xp/DoD, #50 ledger auth, #55 matching auth, #58 ownership, #62 bank auth, #75 depth, deploy #72–79                             |

**Parallelization:** L1–L11 fan-out in waves (e.g. L1+L2+L5 first for P0 speed; then L3+L4+L6+L7; then L8–L11).  
**Then:** adversarial verify every P0/P1 (independent agent, must re-read evidence).

**Deliverables**

- `docs/audit/2026-07-29/02-FINDINGS.json` (machine)
- `docs/audit/2026-07-29/02-FINDINGS.md` (human full set — every finding named)
- `docs/audit/2026-07-29/03-ADVERSARIAL-PASS.md` — confirmed vs rejected

**Exit gate B:** Every layer has a written complete/incomplete status; every P0/P1 either confirmed or discarded with evidence; no silent empty layers.

---

### Phase C — Peace-of-mind package (Nitro product of the audit)

**One primary doc** (scoreboard), not a pile of competing audits:

- `docs/PEACE-OF-MIND-AUDIT-CURRENT.md` (canonical — supersedes dated July-27 peace docs for “current floor”)
- Link from `docs/START-HERE.md`
- Update START-HERE / STATUS claims that are stale **after** verification

**Scoreboard columns (Nitro-judgable)**

| System | What it does (1 line) | Risk now | Proof | Status | What “good” would mean |
| ------ | --------------------- | -------- | ----- | ------ | ---------------------- |

**Sections**

1. Verdict in one breath
2. What Denon built (inventory, plain)
3. Scoreboard
4. Ranked fix queue (P0 → P2) with auto-fix vs escalate tags
5. Explicit non-problems (so fear doesn’t loop)
6. Go-live blockers (even if not deploying)
7. Phase E how future waves get audited

**Exit gate C:** Nitro can open one file and answer: can I trust this enough to let Denon ship again later? What must be true first?

---

### Phase D — Fix sprint (autonomous within doctrine)

**Order**

1. P0 money movement / auth open doors / custody bleed
2. P0 CI doctrine red that proves process blindness (brand scan after vendor)
3. P1 deploy startability, ownership, freeze durability gaps
4. P2 hygiene only if it blocks verify or orientation

**Rules**

- Worktree + feature branch; never main checkout
- Prefer **one service / one concern per PR** (law). Multi-service only if single atomic doctrine fix and protocol allows — else stack PRs
- `pnpm verify` before claim; paste real output in PR
- Self-audit comment on money paths
- Do **not** “fix” by deleting vendor wholesale without escalation if that is a product surface decision — prefer **quarantine / brand-scan skip correctness / isolate wiring** as safe default

**Exit gate D:** All confirmed P0 closed or explicitly blocked; verify green on integration branch or honest red with remaining P0 list; PRs opened (merge per collab rules / CI).

---

### Phase E — Standing wave audit (leverage forever)

**Install**

- `.grok/workflows/denon-wave-audit.rhai` (or project equivalent)
- Short operator doc: `docs/WAVE-AUDIT.md` — when Denon unpauses, run this after each merge wave
- Inputs: `since_sha` or `since_date`
- Outputs: delta inventory + layer hits + P0 alerts
- Hook into START-HERE: “After a Denon wave → wave audit, not full archaeology”

**Exit gate E:** Workflow smoke-checked; doc linked from START-HERE; next chat can run Phase E without re-planning A–D.

---

## 7 · Decision matrix (autonomy vs escalate)

| Situation                                      | Who decides                                   | Default if autonomous                                                                                  |
| ---------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Auth hole confirmed                            | Agent                                         | Fix immediately (P0)                                                                                   |
| Money not via recipe                           | Agent                                         | Fix to recipe / block path                                                                             |
| Float money type                               | Agent                                         | Fix to decimal/bigint pattern                                                                          |
| Brand scan fail from vendor names              | Agent                                         | Fix scan boundaries / quarantine user-facing leak; do not expand vendor                                |
| Keep vendor as product vs reference-only       | **Nitro** only if recommendation is ambiguous | Safe default: **quarantine** (not user-facing brand; not imported into custody paths) and document rec |
| “Is the product ready to launch?”              | Agent states blockers; Nitro later            | Do not soft-launch                                                                                     |
| Split vs combine fix PRs                       | Agent                                         | One concern per PR                                                                                     |
| Whether to message Denon                       | **Nitro**                                     | Silence                                                                                                |
| Jurisdiction / KYC product posture beyond docs | Escalate if changing law                      | Follow existing KYC posture docs                                                                       |
| Format-only CI red                             | Agent                                         | Fix                                                                                                    |

**Escalation format (when used):** 5 lines max — decision, options, recommendation, risk if wrong, what freezes until answer.

---

## 8 · Anti-drift protocol (orchestrator must obey)

1. **Baseline SHA frozen** at A; if `origin/main` moves mid-program, note delta but do not expand scope unless P0 security on new tip.
2. **Layer checklist** must all be marked complete/incomplete before C is “done.”
3. **Finding IDs stable** across docs and fix PRs.
4. **No new features** in fix branches.
5. **Every “fixed” claim** pairs with command output.
6. **Session handoff:** if context compacts, resume from `docs/audit/2026-07-29/` + peace-of-mind current — not from chat memory.
7. **Completeness rule:** compress detail, never omit a named system or layer.

---

## 9 · Execution sequence (after green light only)

```
T0  Green light from Nitro
T1  Phase A worktree + baseline + inventory + verify/CI
T2  Author/validate wave-audit workflow skeleton (may refine after B)
T3  Phase B parallel L1–L11 → adversarial verify
T4  Phase C peace-of-mind + START-HERE refresh
T5  Phase D fix queue P0→P1 → PRs → verify
T6  Phase E save standing workflow + WAVE-AUDIT.md
T7  Final Nitro brief: verdict, PR links, remaining non-P0, how to re-run E
```

**No step before T0.** This doc is preparation only.

---

## 10 · Deliverable index (what “complete” files exist)

| Path                                           | Role                                  |
| ---------------------------------------------- | ------------------------------------- |
| `docs/FULL-AUDIT-PROGRAM-2026-07-29.md`        | This program (method law for the run) |
| `docs/audit/2026-07-29/00-BASELINE.md`         | Machine truth @ SHA                   |
| `docs/audit/2026-07-29/01-INVENTORY.md`        | Full system set                       |
| `docs/audit/2026-07-29/02-FINDINGS.md`         | Full findings                         |
| `docs/audit/2026-07-29/03-ADVERSARIAL-PASS.md` | Confirmed/rejected                    |
| `docs/PEACE-OF-MIND-AUDIT-CURRENT.md`          | Nitro scoreboard (canonical)          |
| `docs/WAVE-AUDIT.md`                           | Standing loop                         |
| `.grok/workflows/denon-wave-audit.rhai`        | Automation                            |
| Fix PRs                                        | P0/P1 remediation                     |

Entry chain: link PEACE-OF-MIND-CURRENT + WAVE-AUDIT + this program from `docs/START-HERE.md` when C/E land.

---

## 11 · Success criteria (program done)

- [ ] Baseline SHA recorded; inventory complete (every system named)
- [ ] All 11 layers marked complete with findings or explicit clean
- [ ] Every P0/P1 adversarially verified or rejected with evidence
- [ ] Peace-of-mind scoreboard exists and is linked from START-HERE
- [ ] Confirmed P0 fixed or blocked with written reason
- [ ] `pnpm verify` evidence on fix branch
- [ ] Standing wave-audit workflow + doc exist
- [ ] Nitro brief: one verdict + links + remaining risk in plain language

---

## 12 · Why this is the best approach (for Nitro)

1. **Matches the failure mode** — Denon ships waves; the bug class is auth/money/deploy honesty, not missing a CSS file. Layers target that.
2. **Matches how you control** — scoreboard + auto-fix + tiny escalation list.
3. **Matches the law** — doctrine and agent protocol are the judge, not taste.
4. **Matches tool leverage** — parallel judgment agents + workflows for wave reuse; orchestrator prevents drift.
5. **Matches “all out” without waste** — all-out on risk coverage and second-pass proof; not on vendor screenshots.
6. **Leaves leverage** — Phase E means the next Denon unpause does not require this planning conversation again.

---

## 13 · Prep already known (does not replace Phase A)

- CI red after #73: brand scan + format; tests green.
- ~34 commits of post–July-27 wave including mounts, edge, money path, deploy, DEX, indexer, WS, vendor.
- Historical self-fixes prove open doors existed on main and were patched under fire — audit must re-check regressions.

---

## 14 · Green-light request

**Nitro: reply `GO` (or “green light”) to start T1.**

Optional one-liners only if you want to override defaults:

- `GO quarantine-vendor` — force vendor quarantine as product decision up front
- `GO audit-only` — stop after Phase C (no Phase D fixes)
- `GO` alone — full A→E with autonomy defaults above

Anything not listed stays as in this document.
