# Plan — PR #86 delta gate (not full archaeology)

**Date:** 2026-07-29  
**For:** Nitro (control) · agents (execute)  
**PR:** https://github.com/Phantom-X-007/intafaced/pull/86 · branch `release/2026-07-29-consolidated`  
**Baseline main:** `4311cff` (peace floor after #80/#81/#82)

---

## Enhanced mission (what you were really asking)

**Surface:** Denon is offline; merge #86; he moves fast and leaves mistakes — should we full-audit before continuing?

**Unspoken needs:**

| #   | Need                                                                           | Plan answer                                                                                            |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | Catch Denon speed mistakes without freezing product for days                   | **WAVE/delta gate on #86 only** — not A–E full program                                                 |
| 2   | Land real security fixes (open wallet RPC, API-key escalate, trading backdoor) | Merge when **CI green + delta P0 clean** — do not hold security fixes for theatre                      |
| 3   | Control without coding                                                         | You decide merge / go-live / licence forks; agents run format, wave, fixes                             |
| 4   | Not rubber-stamp “it’s green”                                                  | Verify **GitHub CI**, not Denon’s local gate story                                                     |
| 5   | Vendor map without gutting money doctrine                                      | UI = `vendor/<exchange-tree>` @ :8090; **books still TS ledger**; vendor-as-sole-money still forbidden |
| 6   | Licence landmines not silently “done”                                          | Merge can ship code + honest blockers; **chart + MySQL connector wait for Denon**                      |
| 7   | Fast + quality tooling                                                         | L0 machine → parallel risk layers → maker-checker on P0 → format fix → merge → update PEACE            |

**Verdict (strategy):**  
**Do not start a full new audit before continuing.**  
**Do** a hard **delta gate** on #86 (WAVE-AUDIT recipe + claimed-fix verification), fix the Prettier red, merge when clean, then optional residual queue (CORS, dual-book Java, licences). Full A–E only if delta finds dual-book “vendor is the ledger” or main money doctrine is on fire.

---

## Framing

```
Denon speed wave (#86)
        │
        ▼
┌───────────────────┐
│ L0 machine truth  │  brand · custody · format · CI tests
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ Claimed P0 fixes  │  verify in code (not PR prose)
│ still closed?     │
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ Residual risk     │  CORS · Java wallet dual books · GPL · TV licence
│ named, phased     │  P0-before-merge vs post-merge queue
└─────────┬─────────┘
          ▼
   CI green ──► squash-merge #86 ──► update PEACE floor
          │
          └── red ──► fix only what's blocking (no archaeology)
```

---

## What #86 is (one breath)

Consolidated release: **shell rebrand** + **three custody locks** + **auth scope issuance** + **licence inventory** + deploy gate widening. ~218 files. Not multi-asset ledger enum (that stays Denon-only).

### Claimed security fixes — verification posture

| Claim                                                     | Evidence posture (initial)                                                        | Merge bar                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| API-key privilege escalation                              | `assertDelegatableScopes` + grantor = principal scopes; tests for escalate refuse | Must stay                                       |
| Wallet RPC open withdraw                                  | `RpcAuthInterceptor` + `RpcSecurityConfig`; fail closed                           | Must stay                                       |
| Trading backdoor / TestController / OrderController holes | Controllers deleted in custody fix commit                                         | Must stay                                       |
| Prettier / format CI                                      | 4 docs failed format:check                                                        | **Must fix before merge**                       |
| Known pay test disagreement                               | Named in PR; CI Tests job still **passed** on GitHub                              | Follow-up, not silent skip                      |
| CORS wildcard + credentials                               | Named **unfixed** in STATUS                                                       | Post-merge P1 (needs origin allowlist decision) |
| TradingView no licence / MySQL GPL                        | `LICENCE-POSITION.md`                                                             | **Do not invent** — Denon product call          |

---

## Decomposition (ordered work)

### Phase 0 — Freeze & honesty (minutes)

1. `git fetch`; tip of #86 vs main
2. CI matrix: doctrine / tests / typecheck-format / DoD
3. Refuse “green” if format or doctrine red

### Phase 1 — Unblock CI (minutes) **[in progress]**

1. Worktree from release branch
2. Prettier write on the 4 failing docs
3. Push so #86 CI re-runs green

### Phase 2 — Delta audit (WAVE) (parallel agents)

1. **Inventory** delta since `4311cff`
2. **Parallel layers:** money · auth · deploy/brand/vendor
3. **Claim check:** re-read each security fix with file evidence
4. **Cheat-diff:** no test gutting on money/auth files
5. Output: P0-before-merge / P1-after / P2 park

### Phase 3 — Merge gate

Merge **only if:**

- Doctrine + Tests + format green
- No open P0 from Phase 2 on this delta
- Nitro explicit go (or standing “merge when clean” from this plan)

### Phase 4 — After merge (same day, not archaeology)

1. Update `PEACE-OF-MIND`: vendor = product **UI**; books = ledger; residual CORS + licences
2. Restack/close stale docs PRs (#85 security floor, #84 Stream A) if conflicted
3. Residual queue for next coding session (not merge blockers unless P0)

### Explicit non-goals

- Full A–E restart
- Strix / live exploit without go + non-prod
- Merging `feat/multi-asset-instruments`
- Building features in `apps/web`
- Guessing licence path for TradingView or MySQL connector

---

## Tooling & workflow (how we move fast without quality loss)

| Tool                                                               | Use                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **GitHub CI**                                                      | Law truth — not local “I ran brand-scan” alone                                     |
| **`pnpm scan:brand` / `custody` / format**                         | L0 before merge                                                                    |
| **`docs/WAVE-AUDIT.md` + `.grok/workflows/denon-wave-audit.rhai`** | Parallel delta risk layers                                                         |
| **Maker-checker subagent**                                         | Fresh context on any P0 found                                                      |
| **Worktree**                                                       | Never edit main checkout                                                           |
| **Security floor**                                                 | `docs/SECURITY-FLOOR-AFTER-AUDIT-2026-07-29.md` (Track A still partial after this) |

**Do not invent:** Semgrep/gitleaks install mid-merge unless a delta finding forces it. Prefer land #86 security fixes first.

---

## Recommended sequence for Nitro (plain)

1. **Authorize:** “delta gate + format + merge when green” — not full audit first.
2. Agents finish Prettier → wait CI green.
3. Agents finish WAVE findings list — you see only P0s that block.
4. **You (or agent on your order):** squash-merge #86.
5. Next session: residual CORS + PEACE update + licence wait for Denon.

---

## Enhanced paste prompt (for this or next agent)

```
MISSION: PR #86 delta gate + land when clean. Nitro operator mode.

UNSPOKEN BAR
- Denon is fast and leaves mistakes — catch them on THIS delta, not full archaeology.
- Security holes in #86 should ship; format red must die first.
- UI product = vendor/<exchange-tree> :8090; books = TS ledger; no multi-asset merge.
- Licence blockers stay named for Denon — do not invent.

DO
1. Worktree from origin/release/2026-07-29-consolidated (or current fix branch).
2. Prettier the four docs that broke format:check; push; wait CI green on doctrine+tests+format.
3. WAVE-AUDIT delta since 4311cff: L0 + parallel money/auth/deploy; verify three claimed custody fixes with code evidence.
4. Verdict: merge-ready / fix-list (P0 only before merge).
5. On Nitro go or standing order: squash-merge #86; update PEACE one line (vendor UI vs books).
6. No commits except format/wave fixes + merge. No Strix. No full A–E.

DELIVERABLE
One-line verdict + P0 list + PR/CI proof + next residual (CORS/licences).
```

---

## Status log

| Step                          | Status                                        |
| ----------------------------- | --------------------------------------------- |
| Strategy pick (delta vs full) | **DONE** — delta/WAVE                         |
| Product framing subagent      | **DONE** — agrees                             |
| Security claim spot-check     | **DONE** — MERGE_AFTER_FORMAT                 |
| Prettier unblock              | **DONE** — pushed to release branch `af87540` |
| WAVE / security delta         | **DONE** (code-reviewer + explore)            |
| Merge                         | **WAIT** green + no P0                        |

---

## Sources

- PR #86 body + CI logs (format fail on 4 md files)
- `docs/WAVE-AUDIT.md` on main
- Branch STATUS / HANDOVER / SPLIT-BOARD / LICENCE-POSITION
- PEACE-OF-MIND vendor quarantine line on main
