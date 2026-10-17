# Wave audit — after Denon (or large agent) ships again

**Purpose:** cheap, complete-enough re-scan after a merge wave — not full archaeology.  
**Full method:** [`FULL-AUDIT-PROGRAM-2026-07-29.md`](FULL-AUDIT-PROGRAM-2026-07-29.md)  
**Last full floor:** [`PEACE-OF-MIND-AUDIT-CURRENT.md`](PEACE-OF-MIND-AUDIT-CURRENT.md)  
**AFK mega paste:** [`MEGA-AUDIT-PASTE-2026-07-29.md`](MEGA-AUDIT-PASTE-2026-07-29.md) — use when main moved a lot and Nitro cannot re-prompt.

---

## When to run

After a burst of merges (Denon **or** Nitro agents) moves money/auth/deploy, or you notice main is far ahead of the PEACE tip SHA.  
Do **not** re-run A–E full program unless: main is red on doctrine/money tests, law version changes, or peace-of-mind and reality violently disagree.

**Mega-wave threshold:** ≥3 money-touching merges, or any open Denon `release/*` PR, or PEACE tip > ~10 commits behind `origin/main` → use the mega paste (full layers on delta + pre-merge open release PRs), not a skim.

---

## Operator steps (agent does these — Nitro does not)

1. **Freeze tip:** `git fetch origin && git rev-parse origin/main`
2. **Freeze since:** PEACE tip SHA (or last audited SHA). If PEACE is stale, say so and use last known audited merge.
3. **Open PRs:** `gh pr list` — pre-audit money/release branches **before** merge.
4. **Delta list:** commits/PRs + path inventory since since-SHA (name every money/auth/deploy touch).
5. **L0 machine truth first:** `pnpm scan:brand`, `pnpm scan:custody`, `pnpm format:check`, `pnpm tracker:check`, CI status, `pnpm verify` if feasible
6. **Risk layers (only on delta + open release tips):**
   - L1 doctrine / money law
   - L2 auth / publicProcedure / WebAuthn / ownership
   - L3 money paths (claim-before-post, reverse atomicity, convert/stake/mint/governance/AMM/pay)
   - L4 plane split + dual-book vendor
   - L5 edge / compose / ports / Dockerfile
   - L6 mount honesty (built router **registered** + edge route)
   - L7 WS / terminal delta
   - L8 tracker `done` honesty
   - L9 vendor only if touched
7. **Adversarial = maker-checker** on every new P0/P1:
   - fresh context · read-only tools · assume broken
   - prefer **cross-family** model when available
   - critic does not implement the fix
8. **False-done check** on fix diffs (weakened tests, empty catch, type-suppression on money files)
9. **Fix P0** without waiting; open PR; verify real output
10. **Update** `PEACE-OF-MIND-AUDIT-CURRENT.md` tip + scoreboard + residual queue
11. **Archive** under `docs/audit/YYYY-MM-DD-wave/` with claim-tags

Method depth: [`PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md`](PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md)

---

## Workflow automation

Project workflow: `.grok/workflows/denon-wave-audit.rhai`

Args:

```json
{ "since_sha": "<last peace-of-mind baseline>", "worktree": "<path to clean checkout>" }
```

Stage routing: mechanical = inventory/CI/greps · judgment = money/auth/doctrine · skeptic = separate strong model.

Manual equivalent if workflow unavailable: this checklist + parallel explore agents on L2/L3/L5/L6 for the delta only.

---

## Exit criteria for a wave

- [ ] New tip SHA recorded (+ open release PRs named)
- [ ] Brand/custody/format/tracker stated (L0)
- [ ] Every new money or auth surface judged (named set)
- [ ] P0 fixed or blocked with reason
- [ ] Adversarial pass named for each P0/P1 (not self-grade only)
- [ ] Peace-of-mind scoreboard lines updated
