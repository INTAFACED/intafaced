# MEGA AUDIT — V2 EXECUTION OVERLAY (lifts + re-confirm)

**Read order:** this file **after** `docs/MEGA-AUDIT-PLAN-V2-2026-07-30.md`.  
**Rule:** V2 is the spine. This overlay **only adds or corrects** — never shrinks coverage.  
**Written:** re-audit of V2 against live machine after prior-plan review (2026-07-30).

---

## 1 · Verdict on plan V2

|                                           |                                                                                                                                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overall**                               | **PASS — use as executable spine**                                                                                                                                                                                                                             |
| **What plan V2 added (keep all)**         | Dead baseline pin · skip ledger · CI wording with run id · L10 migrate-in-place · L11 lockfile · loop bounds · append-as-you-go archive · worktree prune / disk · format:check / full `gate` · open-PR disposition · fan-out map · false-done list · non-goals |
| **Where plan V2 limited us (lift below)** | Missed local `.tools/pnpm` · tip/open-PR freeze went stale · “never `--admin`” over-read from API perms (plain merge works; try order is better) · risk of treating “no Postgres” as “money not judgable at all”                                               |

---

## 2 · Lifts (mandatory — do these)

### 2.1 PNPM resolution (prefer local binary)

Plan V2 said only `npx`. Live machine also has:

`/Users/Nitro/projects/Sovereign/.tools/pnpm/pnpm` → **10.25.0**

**Order every command:**

1. If `test -x /Users/Nitro/projects/Sovereign/.tools/pnpm/pnpm` → use that as `PNPM`.
2. Else `PNPM="npx --yes pnpm@10.25.0"`.
3. Never require global `pnpm` on PATH.

### 2.2 Re-freeze tip every run (V2 constants go stale)

At plan write, tip was `#171` / later `#173`. **Phase 0 always:**

```
git fetch origin main && git rev-parse origin/main
gh pr list --state open
git log --oneline 8a8c19b..origin/main | head -80
```

- **SINCE stays** `8a8c19bc626e6dada49a33be1f88d17873f42502` (#107) unless PEACE gains a newer audited tip SHA _this_ run.
- **TIP** = whatever `origin/main` is **now** (include #169–#173 Stream A uiproof + any later merges).
- Open-PR dispositions: re-list live. Do **not** assume #169/#170 still open (they may already be on main).

### 2.3 Merge policy (lift, do not block)

Repo permissions for `ZenYoda3` often report `admin: false` and main has **no** branch protection. Successful cook merges used ordinary squash (sometimes with `--admin` when the harness offered it).

**Order:**

1. `gh pr merge --squash --delete-branch` (default).
2. If merge is blocked by required checks that never run (zero-step failures), document run id; merge with the same method that already landed the cook (including `--admin` **once** if it succeeds).
3. Never `git push origin main`. Never force-push.
4. PR body always carries local proof block + skip ledger if tests ran.

Do **not** strand finished P0 fixes because the plan said “admin will 403” without trying plain squash.

### 2.4 Money judgment without Postgres (do not under-audit)

Skip ledger stays **mandatory**. In addition:

- **L3 code-path adversarial sample is still required** on tip for: balance REST, private place/cancel/cancelAll, convert, payment links/checkout, yield/buyback if in delta, token surfaces in delta.
- Verdict language:
  - `CODE-REVIEWED + UNIT (no DB)`
  - `SKIPPED-MONEY-SUITE (named file)`
  - never `MONEY VERIFIED E2E` without Postgres + suite green.
- If operator later installs Postgres, re-run only money suites + flip those lines.

### 2.5 Coverage floors plan V2 already set — do not drop

Still required: all Phase 2 surfaces including the eight v1 dropped; L10 M1 on #167; L11 lockfile; residuals 1–12; full CI-mirror L0; prune worktrees; append archive as you go.

### 2.6 Stream A / uiproof in delta

If tip includes #169/#172 (or successors):

- Judge as **deploy/tooling + docs**, not money.
- Honesty residual: any PROOF.md / Chromium claim must be `UNVERIFIED` unless re-run proves it. Do not “fix” UI by inventing green.

### 2.7 Parallel quality (use subagents hard)

| Wave | Who                 | What                                                                             |
| ---- | ------------------- | -------------------------------------------------------------------------------- |
| A    | parallel mechanical | L0 gate families, delta inventory, lockfile, migrate list                        |
| B    | parallel judgment   | L1–L4 + L10 money/auth/plane/migrate                                             |
| C    | parallel judgment   | L5–L7 edge/mount/ws                                                              |
| D    | parallel            | L8–L9–L11 tracker/brand/supply                                                   |
| E    | parallel critics    | one read-only critic **per** P0/P1 (fresh context; assume finding and fix wrong) |
| F    | serial              | implement fixes high→low risk; one concern per PR; re-L0 affected                |

Unclear tier → session-model judgment. State batch→tier map once before fan-out spend.

### 2.8 Grind scheduler

Pause or ignore 45m product grind for the audit duration (V2 F11). Audit owns the session.

### 2.9 Compaction

Archive files in `docs/audit/2026-07-30-afk-cook-mega/` **as each phase ends**. Cold resume from last complete `0N-*.md`.

---

## 3 · What we refuse to “limit” ourselves with

| False limit                          | Correct stance                                  |
| ------------------------------------ | ----------------------------------------------- |
| “No pnpm → cannot run gates”         | Use `.tools/pnpm` or `npx`                      |
| “No Postgres → cannot judge money”   | Skip ledger + **mandatory** code-path L3 sample |
| “admin:false → cannot merge”         | Squash merge works without admin; try, prove    |
| “Only list services v1 named”        | Diff-derived table only                         |
| “Absence of findings = failed audit” | Valid result if gates + residual verdicts exist |
| “Rebuild product to look thorough”   | Non-goal                                        |

---

## 4 · Exit criteria (V2 list + these)

All of V2 § Exit criteria, **plus**:

- [ ] PNPM path recorded (`.tools` or `npx`)
- [ ] Tip re-frozen this run (SHA + open PR list)
- [ ] L3 money code-path sample complete even if DB suites skipped
- [ ] Stream A / uiproof honesty if in delta
- [ ] Overlay lifts applied (this file in archive)

---

## 5 · One-breath success for Nitro

**Sound for Denon to open GitHub:** doctrine green locally · no open agent P0 · money/auth paths code-reviewed with honest skip ledger · migrations L10 answered · PEACE has a **literal tip SHA** · residuals named (CI red, no local money e2e, empty OHLCV/positions, sandbox rails, chain) · no theater.
