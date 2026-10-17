# Mega audit — post AFK cook (2026-07-30)

**Purpose:** Make Nitro’s AFK ship wave **soundproof and Denon-presentable** — not rebuild the OS, not re-run closed 2026-07-29 A–E archaeology.  
**Tip at plan write:** re-check `git rev-parse origin/main` (plan written near **#168**).  
**Baseline since:** last peace floor in `docs/PEACE-OF-MIND-AUDIT-CURRENT.md` (if older than cook, use first cook merge ~**#118** / pre-compact #110 region as delta start).  
**Method:** `docs/WAVE-AUDIT.md` · `docs/FULL-AUDIT-PROGRAM-2026-07-29.md` · `docs/MEGA-AUDIT-PASTE-2026-07-29.md`  
**Cook map:** `docs/GRIND-LOOP-ACTIVE.md` · `docs/AFK-COOK-SCOREBOARD-2026-07-30.md`

---

## What Nitro is actually asking (enhanced)

| Said                                                 | Means                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| “Insane amount of work”                              | ~50 merges in one cook on `Phantom-X-007/intafaced` — prove it is **real and safe**, not volume theater                        |
| “Crazy audit / mega audit”                           | **Complete risk coverage of the cook delta**, not a skim and not infinite repo archaeology                                     |
| “Merge-ready / don’t embarrass me in front of Denon” | Doctrine green, money paths fail-closed, **no fake done**, honest tracker, no brand/custody red, no fleet-down migrations left |
| “Soundproof / checks out”                            | Maker-checker on money/auth; local verify proof; **never claim GitHub CI green** while billing-blocked                         |
| “Plan completeness then run to the end”              | Freeze tip → inventory → L0 → layered risk → adversarial → **fix P0** → update peace scoreboard → archive → stop               |

### Unspoken needs (deduce and honor)

1. **Peace of mind without reading code** — one verdict + scoreboard he can trust.
2. **Denon can open GitHub and not flinch** — no obvious money/auth holes, no brand red, no broken migrate.
3. **Not sold theater** — empty OHLCV/positions stay honest; no “CI green” lie; convert/tracker not inflated.
4. **Agent owns the loop** — worktrees, verify, PRs, merge policy; no git homework.
5. **Stop inventing product** — this program is **audit + P0 fix**, not a second cook.
6. **Survives compact** — durable archive under `docs/audit/` + updated PEACE tip SHA.

### Explicit non-goals

- Rebuild the Definitive Build end-to-end (tracker still ~⅓ done — **out of scope**).
- Full monorepo vendor media archaeology.
- Live exploit frameworks without explicit go.
- Messaging Denon unless Nitro asked.
- Re-opening closed 2026-07-29 P0s unless **regression proved** on tip.

---

## New chat vs this chat (decision)

|            | **New chat (recommended)**                      | Stay in this chat                              |
| ---------- | ----------------------------------------------- | ---------------------------------------------- |
| Bias       | Fresh eyes; no sunk-cost from building the cook | Built the cook — under-rates own choices       |
| Context    | Full budget for multi-layer audit               | Already compacted / long; risk of shallow pass |
| Continuity | Needs paste (below)                             | Has cook memory                                |
| When       | **Default for mega audit**                      | Only if paste is lost and tip frozen same day  |

**Recommendation: open a new chat and paste the block under “PASTE.”**  
This chat stays for status / loop control only. Do **not** run two competing mega-audits at once.

---

## Plan (complete — run in order)

### Phase 0 — Freeze (no opinions yet)

1. `export GH_TOKEN` from agent-auth (never print).
2. Worktree from `origin/main` only — never main checkout.
3. Record **tip SHA** + time.
4. Record **since SHA** from `PEACE-OF-MIND-AUDIT-CURRENT.md` tip (or ~#110/#118 if PEACE older than cook).
5. `gh pr list --state open` — must be empty or named; pre-audit any open money PR.
6. List **merged PR numbers** in since→tip (name every money/auth/deploy touch).

### Phase 1 — L0 machine truth (hard gate)

Run on clean worktree tip; paste **real exit codes**:

| Gate         | Command family                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| Brand        | `pnpm scan:brand`                                                                                         |
| Custody      | `pnpm scan:custody`                                                                                       |
| Vendor-shell | `pnpm scan:vendor-shell`                                                                                  |
| Workspace    | `pnpm scan:workspace`                                                                                     |
| Tracker      | `pnpm tracker:check`                                                                                      |
| Migrations   | migration-check / dod-gate migrations                                                                     |
| DoD sample   | `node tooling/ci/dod-gate.mjs` for **svc-trade, svc-notify, svc-identity, svc-pay, svc-ws, svc-protocol** |
| Verify       | `pnpm verify` if feasible; else **per-service** `test` + `typecheck` for every service touched in delta   |
| CI           | State honestly: billing-blocked / red / green — **never invent green**                                    |

**Red L0 = fix or block before deeper narrative.**

### Phase 2 — Delta inventory (named set, no silent drops)

Inventory every path in since→tip that touches:

- `packages/ledger-client/**`, recipes, money types
- `services/svc-trade/**` (REST, convert, orders, fills)
- `services/svc-pay/**` (links, checkout, rails)
- `services/svc-identity/**` (keys, subaccounts, webauthn if in delta)
- `services/svc-notify/**`
- `services/svc-ws/**` private stream
- `services/svc-edge/**` routes
- `services/svc-protocol/**` factory honesty
- `apps/web/**` terminal tape
- `tooling/tracker/features.mjs` status flips
- `drizzle/**` migrations (**especially #167 class**)

Produce a table: **PR | surface | money? | auth? | deploy?**

### Phase 3 — Risk layers on delta only

| Layer                | Question                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **L1 Doctrine**      | Balances only via ledger-client? No money as `number` on wire paths?                              |
| **L2 Auth**          | Private REST / tRPC fail-closed without edge principal? Scopes correct?                           |
| **L3 Money**         | place/cancel/cancelAll/convert/deposit-withdraw paths still single money path? Claim-before-post? |
| **L4 Plane**         | Protocol surfaces still non-custodial? Factory not inventing 0x0 success?                         |
| **L5 Edge/deploy**   | `/api/v1` preservePath; compose/ports/Docker for new services (notify)?                           |
| **L6 Mount honesty** | Router registered + edge route for every “shipped” surface?                                       |
| **L7 WS/terminal**   | Private orders/fills JWT; public tape; no fake candles                                            |
| **L8 Tracker**       | `done`/`wip`/`ready` match code; scoreboard not lying “next” items                                |
| **L9 Brand**         | No model-vendor / partner names in shipped docs/UI                                                |

Known residuals to **re-verify** (do not drop):

- Balance self-only `principal.userId`
- Convert kill-switch + hold path
- Pay checkout no card invent
- subAccounts.revoke soft only
- subAccountId on placeOrder ownership/revoked gate (prior residual)
- Market order `cost` when price null
- Scoreboard free-mountains stale
- Migration backfill discipline post-#167

### Phase 4 — Adversarial (maker-checker)

For **every new P0/P1** finding:

1. Implementer proposes fix in worktree.
2. **Separate read-only critic** (fresh subagent) assumes broken; no implement.
3. Prefer cross-family critic when available.
4. **False-done check** on fix diff (weakened tests, empty catch, `as any` on money).
5. Local tests green → PR → admin-merge **only if** CI billing-blocked and local proof pasted.

### Phase 5 — Fix until exit (P0 first)

| Severity  | Action                                           |
| --------- | ------------------------------------------------ |
| **P0**    | Fix same program; merge; re-run affected L0      |
| **P1**    | Fix or open PR with owner; must not leave silent |
| **P2**    | Residual queue in PEACE + archive                |
| **Human** | Named only: billing, chain, licences, real rails |

### Phase 6 — Close the books

1. Update `docs/PEACE-OF-MIND-AUDIT-CURRENT.md` tip SHA + scoreboard + residual queue.
2. Archive under `docs/audit/2026-07-30-afk-cook-mega/` (L0 log, findings, adversarial notes, PR list).
3. Scrub **stale scoreboard** free-mountains if still lying.
4. Update `docs/GRIND-LOOP-ACTIVE.md` only if high water / audit status changes.
5. Chat to Nitro: **verdict only** — pass/fail, P0 count, PR links, what Denon would still flinch at.

### Exit criteria (all required)

- [ ] Tip SHA frozen and recorded
- [ ] Since SHA named
- [ ] L0 gates real exit codes
- [ ] Every money/auth surface in delta **named and judged**
- [ ] Every P0 fixed or human-blocked with reason
- [ ] Adversarial pass on each P0/P1
- [ ] PEACE scoreboard updated
- [ ] Archive folder complete
- [ ] No open agent-owned audit-fix PRs rotting
- [ ] Explicit: **GitHub CI still not green unless billing fixed**

---

## PASTE — new chat only

```
MEGA AUDIT — post AFK cook (Nitro). Full autonomy. Compaction-safe.

I am non-technical. Infer unspoken needs: Denon-presentable main, soundproof
money/auth, no theater, no git homework, peace-of-mind scoreboard, fix P0s to
the end. This is AUDIT + P0 FIX only — not a second product cook.

READ FIRST (order):
1) docs/MEGA-AUDIT-AFK-COOK-2026-07-30.md  ← plan + exit criteria (this file)
2) docs/PEACE-OF-MIND-AUDIT-CURRENT.md
3) docs/WAVE-AUDIT.md
4) docs/GRIND-LOOP-ACTIVE.md
5) docs/AFK-COOK-SCOREBOARD-2026-07-30.md
6) AGENTS.md · AGENT_PROTOCOL.md · INTAFACED_DEFINITIVE_BUILD.md §0
7) Live: git fetch origin main · tip SHA · gh pr list open/merged · since PEACE tip

RULES:
- Worktree only; never main checkout; never push main.
- AUTH: GH_TOKEN from ~/.grok/agent-auth/github_token — never print.
- L0 machine truth first; paste real exit codes.
- Delta = since PEACE tip (or ~#110/#118 if PEACE older) → origin/main.
- Name every money/auth/deploy touch — no silent drops.
- Maker-checker on every P0/P1; critic read-only; false-done check on fixes.
- Local green + report; CI may be billing-blocked → admin-merge only with proof; NEVER claim Actions green.
- Brand clean (no model-vendor names in scanned docs/UI).
- Doctrine: no balances outside ledger-client; no money as number.
- Update PEACE scoreboard + archive docs/audit/2026-07-30-afk-cook-mega/ before stop.
- Chat = verdict only; full findings in durable docs same turn.

DO NOT:
- Rebuild the whole Definitive Build / pad features to look busy.
- Re-ship already merged cook PRs.
- Full vendor media archaeology.
- Message Denon unless I asked.
- Stop at “looks fine” without L0 + money sample + adversarial on P0/P1.

RUN the plan in docs/MEGA-AUDIT-AFK-COOK-2026-07-30.md Phases 0–6 until exit criteria are met.
Start Phase 0 now.
```

---

## What “success” looks like for Nitro

| Signal                              | Meaning                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| **Verdict: sound for Denon review** | L0 green, no open P0, residuals named and non-embarrassing                               |
| **Verdict: not yet**                | Named P0s with PRs or human blockers only                                                |
| **Embarrass risk still OK to name** | CI red (billing), sandbox rails, OHLCV empty, chain not propped — **honest, not hidden** |

---

## Relation to the 45m grind loop

- Grind loop = product babysit (DRAINED).
- Mega audit = **separate program**; stop the grind loop if it competes for attention, or leave it — it must **not** open product PRs during audit.
- Prefer **pause grind scheduler** while mega audit runs.
