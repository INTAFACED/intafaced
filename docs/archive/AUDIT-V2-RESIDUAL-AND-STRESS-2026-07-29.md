> **CLOSED 2026-07-29** — residual P1 shipped in #80; P2 in #81. Remaining deferral L2-6 only (see PEACE-OF-MIND).

# Audit V2 — residual money + proof upgrades (post wave-1)

**Status:** READY TO RUN — wave-1 (PR #80) finished A→E skeleton + fixed open doors  
**Date:** 2026-07-29  
**Does not restart** full archaeology unless PR #80 is abandoned  
**Law:** doctrine §0 · AGENT_PROTOCOL · AGENTS.md · this doc · plan meta-audit

---

## 0 · Why V2 exists

Wave-1 answered: **what is broken and what was on fire.**  
V2 answers: **are the remaining money cracks real under stress, and is “fixed” proven with more than one kind of proof?**

Nitro unspoken needs V2 must satisfy:

| Need                            | How                                                                   |
| ------------------------------- | --------------------------------------------------------------------- |
| Trust without reading code      | Scoreboard updates only — one file                                    |
| Not bottle-neck                 | Auto-fix residual P1; escalate only law forks                         |
| Fear that audit was theater     | Method upgrades: machine + cross-family critic + crash matrix         |
| Fear of missing “amazing tools” | Named shortlist + adopt only what pays (section 4)                    |
| Survive next chat               | This doc + paste prompt in `HANDOVER-AUDIT-V2-PASTE.md`               |
| Don’t stomp wave-1              | Work on residual queue; don’t re-litigate fixed P0s unless regression |

---

## 1 · Floor (do not re-derive from memory)

| Item                | Where                                                   |
| ------------------- | ------------------------------------------------------- |
| Scoreboard          | `docs/PEACE-OF-MIND-AUDIT-CURRENT.md`                   |
| Findings            | `docs/audit/2026-07-29/02-FINDINGS.md`                  |
| Adversarial honesty | `docs/audit/2026-07-29/03-ADVERSARIAL-PASS.md`          |
| Wave-1 PR           | https://github.com/Phantom-X-007/intafaced/pull/80      |
| Baseline SHA        | `a19e337` (wave-1 freeze); re-freeze after #80 merges   |
| Method upgrades     | `docs/PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md` |

---

## 2 · V2 mission (ordered)

### Track A — Residual P1 money (must ship)

1. **L3-1** Withdraw reverse + failed status atomic
2. **L3-2** Token stake claim-before-post
3. **L3-3** Earn deposit claim-before-post

Each fix PR must include:

- Repro or invariant test that **failed before** / **passes after**
- Crash-midway matrix row (kill between steps → what strand?)
- Critic pass: fresh context, read-only, prefer **cross-family** model
- Cheat-diff check (no assertion strip / empty catch / type-suppression on money files)
- `pnpm verify` green on branch

### Track B — Proof upgrades (same sprint, not optional flavor)

| ID  | Work                                                              | Done when                                                                          |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| B1  | L0 machine pass notes in `docs/audit/2026-07-29/04-L0-MACHINE.md` | brand/custody/verify + greps for money-as-number / bare ledger patterns documented |
| B2  | Money journey coverage table                                      | N journeys named, each with invariant + crash points                               |
| B3  | Threat model one-pager                                            | `docs/audit/2026-07-29/05-THREAT-MODEL.md`                                         |
| B4  | Property tests on ≥1 ledger/hold invariant                        | test file on branch, named in peace-of-mind                                        |
| B5  | Update PEACE-OF-MIND residual after A                             | queue shorter; proof columns honest                                                |

### Track C — Parked P2 (only if A green and time left)

Dual-book stake/earn, P2P purpose-key, S2S body bind, RUNNING.md, tracker done-path-only — **do not block** A.

### Track D — Standing stress (install once, run after A)

See section 4 — **not** full red-team production.

---

## 3 · Anti-drift

- Worktree only; one concern per PR when possible
- Do not reopen vendor as product money (quarantine stands)
- Do not message Denon unless Nitro asks
- If #80 still open: stack residual PRs **on top** or wait for merge then branch from new main
- Completeness: name every residual ID even if parked

---

## 4 · Tools — what to use vs skip (peace of mind)

### Use now (high ROI on this repo)

| Tool / pattern                                                                                                                               | Why                                                               | How in V2                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| **Existing** `pnpm verify` / brand / custody / DoD                                                                                           | Already law                                                       | Every PR                             |
| **Maker-checker** (fresh critic, read-only)                                                                                                  | Self-review is weak                                               | Mandatory on money PRs               |
| **Cross-family second eye** (session model ↔ peer family (e.g. Grok/Codex))                                                                  | ~93% findings unique per reviewer family in 2026 multi-tool study | P1 money                             |
| **fast-check** (property tests)                                                                                                              | Crash windows need invariants, not one example                    | Track B4                             |
| **Structural cheat detectors** ([swarm-orchestrator](https://github.com/moonrunnerkc/swarm-orchestrator) or home greps)                      | AI-era false-green                                                | On every fix diff                    |
| **Semgrep custom rules** (optional CE)                                                                                                       | Doctrine as code                                                  | Grow if greps get noisy              |
| **ShopPay-style checklist** ([shoppay-audit-benchmark](https://github.com/Dmatut7/shoppay-audit-benchmark) as _calibration_, not dependency) | Business-logic IDOR/webhook/double-spend patterns                 | L3 agent prompts                     |
| **k6 or autocannon** smoke                                                                                                                   | Concurrent withdraw/stake races                                   | After platform:up; short script only |

### Later / only if go-live approaches

| Tool                                          | Why wait                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| Full CodeQL Pro / paid SAST platforms         | Setup cost; Semgrep/greps first                                              |
| Chaos mesh / toxiproxy full suite             | Valuable for deploy; not needed for residual claim-row bugs                  |
| Live AI pentest frameworks (STRX-class)       | Exploit against real money surfaces — only with explicit Nitro go + non-prod |
| SaaS PR bots (CodeRabbit/Greptile) whole-repo | Optional; multi-agent + scanners cover wave residual                         |
| Mutation testing whole monorepo               | Expensive; use on ledger package only if property tests thin                 |

### Explicit non-goals (waste)

- Line-auditing `vendor/` media
- Rebuilding trade/matching
- 50-agent fan-out on UI
- Production credential use

**Answer to “are we missing amazing tools?”:**  
Wave-1 was **not** missing a magic wand — it found real doors with code reading + tests. What was missing is **proof diversity** (machine rules, property tests, cheat-diff, cross-family critic, short concurrent smoke). Those are V2, not a reason to throw away wave-1.

---

## 5 · Done means (V2)

1. L3-1, L3-2, L3-3 fixed or blocked with doctrine reason
2. Each has failure-style test + critic + verify
3. PEACE-OF-MIND residual queue updated
4. 04-L0 + 05-threat-model + journey table exist
5. Nitro can open PEACE-OF-MIND and see: build OK / still no go-live / why

---

## 6 · Escalation whitelist (unchanged)

- Vendor as real money product
- Live custody risk / go-live call
- Jurisdiction beyond doctrine
- Real money / prod credentials
