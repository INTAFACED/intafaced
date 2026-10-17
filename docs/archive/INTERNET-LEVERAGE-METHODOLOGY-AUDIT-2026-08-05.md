> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# Internet leverage — methodology audit (Phase A gate + Phase B plan)

**Status:** AUDIT COMPLETE · gate decision below  
**Date:** 2026-08-05  
**Tip:** re-derived `origin/main` at audit  
**Inputs:** Phase A plan (harvest) · Phase A audit · Phase B plan · v1/v2 reports · full-horizon map · tip code/PRs/tracker

**Purpose:** Deduce unspoken needs, stress-test plan completeness, refuse lazy green-lights.  
**Not:** shopping. **Not:** implement.

---

## 0 · Gate decision (read first)

| Gate                             | At audit open          | After repair (same program)                                                                 |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| **Phase A proper vs plan §8**    | **FAIL** — §2          | **PASS** — CURRENT-AUDIT refreshed (18 svc, D-S-01…18, open PRs, FUTURE breadth, tip drift) |
| **Phase B plan methodology**     | **FAIL residual** — §3 | **PASS** — plan hardened (Phase A gate, full-horizon, lanes, anti-Top-5, anti-bullshit)     |
| **Prior B outputs**              | PARTIAL                | Evidence kept; execute stamp re-run under gates                                             |
| **Green-light Phase B execute?** | **NO** until repair    | **YES** after Phase A + plan land → EXECUTE-2026-08-05 + full-horizon re-derive             |

**Operator rule honored:** Phase B executed only after Phase A proper + plan completeness.

---

## 1 · Unspoken / implicit needs (inferred — force the plans)

| #   | Unspoken need                               | Evidence you’re enforcing it          | Plan must force                                                        |
| --- | ------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| U1  | Peace: not silently rebuilding kit/services | Rebuild is the expensive failure mode | Phase A USE/WIRE matrices; Phase B exclusion list = Phase A register   |
| U2  | Full future project, not thrift theater     | You rejected max-5 as product         | Phase B = full-horizon map; ranking ≠ ceiling                          |
| U3  | No bullshit / false peace                   | You punish lazy shortlists            | Proof paths, tip re-derive stamps, kill lists ≥ shortlists, hole hunts |
| U4  | Phase A before Phase B                      | Explicit this message                 | Hard gate: Phase A §8 checklist green before B0                        |
| U5  | Doctrine over “cool OSS”                    | Ledger/kit law                        | Dual-book/dual-kit auto-kill; invent ban                               |
| U6  | Three-way ownership collision-free          | Denon/Shehzad/Nitro                   | N/D/S tags; S-only chain; no dual-edit                                 |
| U7  | Class X human                               | Keys, issuers, sanctions content      | Separate X rows; never agent-close                                     |
| U8  | Actionable without encyclopedia             | You need decide altitude              | One-screen Tier order + drillable full map                             |
| U9  | Durable over chat                           | Compact kills work                    | Tip docs + harvest; chat verdict + link                                |
| U10 | Honest “no external fit”                    | Greenfield OK is valid                | Empty-lane “searched + no fit” required                                |
| U11 | Prior research not ignored                  | ORDER-ROUTE, SECURITY-WHEN-PLAIN      | Import as exclusion/start list                                         |
| U12 | Tip drift doesn’t lie                       | apps/web deleted; vendor rename; #748 | Refresh ritual on every Phase A/B execute                              |
| U13 | Denon law factory is leverage too           | Engines stall without D-S             | D-S rows: mandate which kit + ledger, not only code libs               |
| U14 | freeProduct=0 ≠ platform done               | Tracker residual huge                 | FUTURE maps all ready/socket, not only pay/bank                        |

---

## 2 · Phase A — plan completeness vs delivered audit

Phase A **plan law:** harvest `INTERNET-LEVERAGE-CURRENT-AUDIT-PLAN-2026-08-04.md` §8 gates.

| Plan §8 gate                                         | Delivered audit                                          | Tip re-check 2026-08-05                                                                                                                                                    | Verdict                                     |
| ---------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Every `services/svc-*`                               | Listed 17 (no **svc-support**)                           | **18** services including `svc-support`                                                                                                                                    | **FAIL**                                    |
| Vendor shell + admin + major Java                    | High-level V-JAVA                                        | Path is **`vendor/upstream-exchange`**; modules: admin, chat, cloud, core, exchange, exchange-api, exchange-core, market, otc-*, ucenter-api, wallet, job-module, sql, jar | **PARTIAL** — abstract OK, module list thin |
| Money-adjacent packages                              | Yes                                                      | 12 packages on tip                                                                                                                                                         | **PASS**                                    |
| Every Denon D-P0 open PR mapped                      | Listed old pile (#448 #433…)                             | Open human PRs tip: **#428** (Denon p2p), **#346** (Shehzad pay) — pile **stale**                                                                                          | **FAIL**                                    |
| D-S-01…18 leverage mandate each                      | Named subset only                                        | Missing explicit rows for **04,07,08,13–18**                                                                                                                               | **FAIL**                                    |
| Nitro NOW mapped                                     | Yes                                                      | G-P0-1: #748 client landed; `feedLive` still starts false — residual **ops/E2E**, not “no client”                                                                          | **STALE wording**                           |
| Reclaimed FUTURE (pay/bank/futures/otc/copy/algo/id) | Yes                                                      | OK for that subset                                                                                                                                                         | **PASS subset**                             |
| **All** tracker ready/socket FUTURE                  | **No** — academy/agents/ops/launch/market thin or absent | ~89 open rows                                                                                                                                                              | **FAIL vs unspoken U14**                    |
| Tracker done leverage pass                           | Slogan-level                                             | Not full                                                                                                                                                                   | **PARTIAL**                                 |
| Forbidden leverage                                   | Yes                                                      | Still true                                                                                                                                                                 | **PASS**                                    |
| Prior peace maps status                              | Yes                                                      | Need re-mark after vendor rename / apps/web delete                                                                                                                         | **STALE**                                   |
| Hole hunt                                            | Yes                                                      | Must re-run after tip drift                                                                                                                                                | **STALE**                                   |
| No Phase B shopping                                  | Yes                                                      | Pass for Phase A purity                                                                                                                                                    | **PASS**                                    |
| Durable on tip                                       | Yes #747                                                 | Pass                                                                                                                                                                       | **PASS**                                    |
| Matrix schema 7.2 Risk column etc.                   | Incomplete                                               | Plan schema not fully filled                                                                                                                                               | **PARTIAL**                                 |

### Phase A tip-drift facts (must enter refresh)

1. **`apps/web` deleted** (#757) — G-P2-1 largely closed; maps must not say “still in tree.”
2. **Vendor path** = `vendor/upstream-exchange` (rename #771).
3. **Depth client** #748 shipped; G-P0-1 becomes “prove live E2E / residual honesty,” not “no client.”
4. **svc-support** exists — missing from register.
5. Open PR universe collapsed vs Phase A narrative — re-derive only.

### Phase A verdict

**Not properly done** against its own plan + tip.  
**Repair:** Phase A **refresh** (same doc or dated refresh) closing every §8 gate + U14 FUTURE breadth.  
**Until then:** Phase B execute is **blocked** by your rule.

---

## 3 · Phase B plan — methodology holes (even after max-5 kill)

| Hole                                     | Where                                                         | Bullshit risk                                | Fix required                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Top-5 residue**                        | Plan §8 execute prompt still “chat = Top 5”; go options Top-N | Re-teaches thrift ceiling                    | Rewrite execute prompt + done criteria                                                                   |
| **“Narrow decisions”** vs full horizon   | Unspoken #2                                                   | Research shrinks again                       | “Wide map + ranked start order” language only                                                            |
| **No Phase-A-freshness gate**            | B0                                                            | B runs on stale gaps                         | B0 hard-fail if Phase A tip stamp >N days or gates red                                                   |
| **Missing lanes**                        | B1 list                                                       | Academy/agents/ops/token/test/chaos orphaned | Add L-AGENTS, L-ACADEMY, L-OPS, L-TOKEN, L-TEST, L-I18N or N/A                                           |
| **Candidate caps misread as scope caps** | B2 8–12 raw/lane                                              | Agents stop at 5 global                      | Clarify: caps are **per-lane collection**, not project ceiling                                           |
| **Deep card ≤25 global**                 | B4                                                            | Can hide late mountains                      | Full-horizon rows can be shallow; deep only shortlist — **state that**                                   |
| **Prior Phase B “executed” status**      | Plan header                                                   | Confuses re-run                              | Status = living law; re-execute = new report stamp                                                       |
| **Anti-bullshit weak**                   | —                                                             | Stars/memory as “research”                   | Require: tip stamp · ≥3 sources active lanes · GitHub license/push for shortlist · kill≥keep · hole hunt |
| **Import prior terrain**                 | Soft                                                          | Re-discovers exchange-core / gitleaks        | B0 mandatory load ORDER-ROUTE + SECURITY-WHEN-PLAIN                                                      |
| **last30days optional chaos**            | v2                                                            | Fake community claims                        | Optional; disclose degradation; never invent pulse                                                       |
| **Collision open PRs**                   | Soft                                                          | Dual-build                                   | B0 re-derive `gh pr list`                                                                                |
| **Relationship to full-horizon doc**     | Split brain                                                   | Three “canonical” docs                       | Plan names **one** decision surface + research appendix                                                  |

### Phase B plan verdict

**Not green for execute** until plan file is hardened (this program).  
Full-horizon map is the right **shape** but depends on **fresh Phase A** and must not outrun plan law.

---

## 4 · Prior Phase B runs — honesty (not re-litigation)

| Artifact          | Good                              | Bullshit / gap                                             |
| ----------------- | --------------------------------- | ---------------------------------------------------------- |
| v1 #772           | Started lanes                     | Lazy width; fake ranking                                   |
| v2 #774           | Fan-out + gitleaks + metadata     | Still sold max-5; last30days thin                          |
| Full-horizon #780 | Whole-project shape; killed max-5 | Built before Phase A tip refresh; some late rows desk-only |

**Do not claim “Phase B finished”** until: Phase A green + plan green + B0–B8 checklist green on a **new stamp**.

---

## 5 · What “no gaps / full scope / no bullshit” means (acceptance bar)

### Phase A green when

1. Every tip `services/svc-*` in register.
2. Vendor path correct; Java modules named (not only “V-JAVA blob”).
3. Open PRs re-derived (not folklore pile).
4. **All** D-S-01…18 have leverage-mandate or N/A one-liner.
5. FUTURE covers **all** non-done tracker IDs (or explicit “out of product scope” with reason).
6. Tip-drift fixes (apps/web, #748, rename).
7. Hole hunt re-run with named questions.
8. Checklist §8 all true in the audit body.

### Phase B green when

1. B0 gap backlog **from green Phase A** + tracker + boards + open PRs.
2. Every open need has lane **or** “no EXT — IN/GF/LAW”.
3. Full-horizon map complete (not ≤5).
4. Kill list ≥ shortlist.
5. Shortlist deep cards with license/push/doctrine.
6. Sources ≥3 per **active research** lane (lanes marked N/A exempt with reason).
7. Non-regression Phase A restated.
8. Class X separate; S isolated.
9. No implement in research pass.
10. Methodology self-check section passes.

---

## 6 · Repair program (this session) — done in same PR

| Step | Work                  | Output                           | Status      |
| ---- | --------------------- | -------------------------------- | ----------- |
| R1   | Methodology audit     | This file                        | **Done**    |
| R2   | Phase A refresh       | CURRENT-AUDIT rewrite            | **Done**    |
| R3   | Phase B plan harden   | PLAN rewrite                     | **Done**    |
| R4   | Re-check §5 bars      | Gates PASS                       | **Done**    |
| R5   | Phase B execute B0–B8 | EXECUTE + FULL-HORIZON re-derive | **Done**    |
| R6   | Class N PR            | Tip                              | **This PR** |

---

## 7 · Recommendation to operator

- **Do not trust** prior “Phase B complete” as full-scope peace.
- **Do trust** the **method**: Phase A in-repo truth → Phase B external only for true holes → full-horizon, not thrift.
- After repair PR merges: decision surface = **full-horizon** fed by **refreshed Phase A** + **research evidence**.

---

_Board-Delta: Internet leverage methodology audit — Phase A gate red; Phase B blocked until repair_
