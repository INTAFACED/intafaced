> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# Board Clear — Preflight Audit (methodology + blockers)

**Date:** 2026-08-01  
**Tip audited:** `origin/main` @ `346d3c7` (+ fixes in this PR)  
**Purpose:** Hunt anything that would stop or compromise “GO once → finish board.”  
**Verdict after fixes in same PR:** see §9.

---

## 1. What was audited

| Layer              | Sources                                                |
| ------------------ | ------------------------------------------------------ |
| Campaign pack      | All `docs/BOARD-CLEAR-*.md`                            |
| Entry chain        | START-HERE, NITRO-SESSION-PROMPT                       |
| Ownership / lanes  | NITRO-OWNERSHIP, LIVE-LANES, residual campaign         |
| Product UI truth   | FRONTEND-STATE-OF-TRUTH, START-HERE product UI line    |
| Live GitHub        | open PRs, #289 mergeability                            |
| Services inventory | `services/*` for Phase 5 / trade / pay / protocol / ws |
| Doctrine collision | invent bans, Class X, Class M merge gates              |

---

## 2. Critical findings (would block or re-compromise goal)

### C1 — Ownership law forbids shipping trade mountains product

**Where:** `NITRO-OWNERSHIP` §4.6: product law for futures/OTC/copy/algo/MM is Denon-only.  
**Conflict:** Board Clear B2 = all trade mountains in scope with Done bars.  
**Risk:** Cold agent obeys ownership, refuses to ship, reverts to residual theater.  
**Fix:** Precedence: **Board Clear constitution wins for campaign Done bars** as Nitro locked 2026-08-01; still never invent mid/rates/depth; thin slice or §13 OK; force-push spine still banned.

### C2 — LIVE-LANES is residual-era and caps parallel

**Where:** LIVE-LANES residual-coord, ≤3 lanes, stale claims, order-route separate.  
**Risk:** Agents claim wrong program, refuse fan-out, double-build or idle.  
**Fix:** LIVE-LANES rewritten for Board Clear programs P-UI…P-P5; parallel = ownership map not ≤3.

### C3 — Product UI path wrong in execution plan

**Where:** Plan said `apps/web`; reality = **vendor exchange shell :8090** (`vendor/.../05_Web_Front`).  
**Risk:** Agents polish dead spike; web.terminal never Done.  
**Fix:** Constitution + plan + P-UI paths = vendor shell + frontend SoT.

### C4 — #289 not mergeable

**Where:** PR #289 `CONFLICTING`, behind main by ~12, ahead 7. CI was green on old tip.  
**Risk:** “Claimed” but orphan forever if GO agent ignores rebase.  
**Fix:** A-OR-1 mandatory first-class: rebase/fix/merge or split absorb same week; scoreboard tracks.

### C5 — Session prompt still says ≤3 lanes + residual ship gate

**Where:** NITRO-SESSION-PROMPT LIVE-LANES ≤3; commits unless go-all-out.  
**Risk:** Soft undo of Board Clear parallel + autonomy.  
**Fix:** Explicit Board Clear supersession block in session prompt + START-HERE.

### C6 — Chat death has no auto-wake

**Where:** Process assumes human re-pastes GO after compact/session end.  
**Risk:** Campaign freezes if Nitro never re-opens chat.  
**Mitigation (honest):** (a) NEXT+docs resume on any new session with same paste; (b) optional scheduled re-fire documented; (c) **not** full unattended OS process without a host session.  
**Not a doc lie:** Green light = process complete; **host must run an agent session** (or re-open after death with same paste).

---

## 3. High findings (quality / speed, not hard stop)

| ID  | Issue                                                       | Mitigation                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------ |
| H1  | Class M “second adversarial” can become theater delay       | Same agent second pass in PR body; no Denon wait |
| H2  | Phase 5 + all trade + card + protocol is huge               | Waves + anti-partial-forever; Cut+§13 allowed    |
| H3  | Pay card PSP may lack keys                                  | Sandbox E2E = Done                               |
| H4  | Protocol “audit” ≠ external firm                            | Package + deploy proof (locked)                  |
| H5  | Constitution git floor SHA stale                            | Re-check command, not frozen SHA                 |
| H6  | Stale residual high-water / residual campaign still present | Superseded pointers; don’t delete history        |
| H7  | CI thrift vs parallel                                       | ≤5 open code PRs; local verify first             |
| H8  | Denon spine force-push ban still correct                    | Keep                                             |
| H9  | Graphify re-index on docs corpus                            | Agent duty if corpus live                        |
| H10 | OHLCV/candles / mark index need real jobs                   | Ships in plan; no invent                         |

---

## 4. Methodology completeness check

| Element                           | Present?         | Gap?                         |
| --------------------------------- | ---------------- | ---------------------------- |
| Done bars                         | Yes              | UI path fixed                |
| Locked decisions                  | Yes              | —                            |
| Unspoken needs                    | Yes              | —                            |
| Process loops R→…→U               | Yes              | —                            |
| Anti-stall / anti-partial-forever | Yes              | —                            |
| Parallel ownership                | Yes              | LIVE-LANES was stale → fixed |
| NEXT always-file                  | Yes              | —                            |
| Compaction recovery               | Yes              | Host re-paste required       |
| Scoreboard                        | Yes              | —                            |
| GO paste                          | Yes              | Enhanced                     |
| Finish gate                       | Yes              | —                            |
| Conflict with ownership           | **Was critical** | Fixed precedence             |
| Money doctrine intact             | Yes              | Invent bans kept             |
| Order-route claimed               | Yes              | #289 dirty → execute rebase  |

---

## 5. Goal-threat matrix

| Goal threat                       | Status after fix                                                             |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Agent optimizes residual partials | **Mitigated** — Done/Cut scoreboard + anti-partial                           |
| Agent waits for continue          | **Mitigated** — L0 + GO paste                                                |
| Agent invents prices/depth        | **Mitigated** — bans + Class M                                               |
| Agent refuses trade mountains     | **Mitigated** — Board Clear > ownership §4.6 for campaign                    |
| Agent builds apps/web             | **Mitigated** — vendor shell path                                            |
| #289 orphan                       | **Mitigated** — A-OR-1 + scoreboard                                          |
| Parallel collision                | **Mitigated** — program ownership + LIVE-LANES rewrite                       |
| Session dies forever              | **Partially mitigated** — re-paste same GO; no silent OS daemon without host |
| Fake Done                         | **Mitigated** — proof + tracker same turn                                    |
| Scope so large it never ends      | **Managed** — Cut+§13 + 3-ship rule; not unlimited                           |

---

## 6. What we are NOT compromising

- Ledger-only money
- No invent mid/depth/rates/candles
- No Class X prod go-live as agent-done
- No force-push Denon spine
- Worktrees / PR / CI
- Honest Cut over fake Done

---

## 7. Pre-GO physical checklist

- [x] Board Clear docs on main (after this PR)
- [x] Precedence over residual + ownership product-law ban for campaign
- [x] LIVE-LANES Board Clear
- [x] UI = vendor :8090
- [x] #289 dirty named as first-class work
- [x] GO paste includes read order + loops
- [ ] **Human:** open agent session and paste GO (required host)
- [ ] **Human if chat dies:** paste same GO again

---

## 8. Fixes shipped in preflight PR

1. Ownership precedence + Board Clear supersession
2. LIVE-LANES Board Clear rewrite
3. Constitution/plan UI path + #289 note
4. Session prompt + START-HERE conflict kill
5. GO-READINESS final + this audit
6. NEXT updated for post-audit GO

---

## 9. Final green-light verdict

**GREEN LIGHT: YES — say GO.**

Process, Done bars, loops, anti-compromise fixes, and conflict resolution are sufficient for a competent orchestrator to run until scoreboard COMPLETE under constitution **without Nitro decisions**.

**You must:** paste GO in a live agent session (and re-paste if the session dies).  
**You must not:** re-open B1–B5, switch back to residual-only prompts, or expect product Done without the loop running.

**Not guaranteed:** zero agent mistakes, infinite free CI, external audit firm signature, prod PSP keys. Those are covered by self-audit, thrift, audit package, sandbox Done.
