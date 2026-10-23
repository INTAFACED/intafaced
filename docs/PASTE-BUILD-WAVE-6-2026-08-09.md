# BUILD WAVE 6 · 2026-08-09

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tip:** `8da2c561` · **Open:** ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive  
**N=16:** W5 largely banked with long parked lists + ~60 open PRs to babysit; residual still feeds all walls.  
**Parallel OK** with risks: monorepo Tests red cascades (fix only your suites) · market commerce · identity SAFE no · L11/L16 · Shehzad #1177 · features.mjs discipline.

| ID  | Title                  | Kind     |
| --- | ---------------------- | -------- |
| L01 | AGENTS residual        | backend  |
| L02 | ACADEMY residual       | backend  |
| L03 | P2P residual           | backend  |
| L04 | PAY residual           | backend  |
| L05 | TRADE residual         | backend  |
| L06 | BANK residual          | backend  |
| L07 | MARKET residual        | backend  |
| L08 | NOTIFY residual        | backend  |
| L09 | INDEXER residual       | backend  |
| L10 | WS residual            | backend  |
| L11 | SHELL residual         | frontend |
| L12 | IDENTITY residual      | backend  |
| L13 | TOKEN residual         | backend  |
| L14 | LEDGER residual        | backend  |
| L15 | BOARD+TOOLING residual | tooling  |
| L16 | VENDOR residual        | vendor   |

Files: `docs/paste-w6/` · **next** / **all clipboard**

---

# L01

````markdown
# BUILD LANE L01 — AGENTS residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**1 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-agents/**`

## Fenced

academy p2p pay trade bank market notify shell identity ledger edge protocol

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W5 banked residual — re-verify shipped guards; do not regress money-scope refuse / request-id / fleet matrix.

## Read first

1. LANE-STOP-L01-W5 2. open agent PRs 3. tracker WIP navigator/support/scanner/merchant/copy-intel ghosts

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                 | Done bar (start — tighten from law)   |
| ---- | ------------------------------------ | ------------------------------------- |
| A0   | Merge open agent PRs / stop notes    | green on tip                          |
| A0   | Ghost clear five WIP agent rows      | evidence clear or live PR             |
| A1   | Fleet matrix residual                | boot-register / runSession honesty    |
| A1   | Money-scope residual                 | agents cannot grant pay/ledger scopes |
| A2   | Scanner live-or-refuse residual      | dark allowlist unbilled               |
| A2   | Navigator residual                   | hostile tools refused                 |
| A2   | Support/merchant/copy-intel residual | TRK Done bars                         |
| A3   | portfolio/launch/risk/coach/growth   | park law-thin                         |
| A3   | metering-off product ruling          | park or honest audit-only             |
| A3   | admin multi-window settleSession     | optional Class M or park              |
| A3   | AGENTS.md count vs Stage-1 five      | L15 handoff                           |
| A3   | Engine B README matrix               | complete                              |

## Engine B — Promise falsification (UNBOUNDED)

README · guardrails · metering · fleet · each agent module.

## Engine C — Matrix / attack surface

Mounted agents · bill paths · allowlists · tool permissions · request-id.

## Nitro-only (never invent)

Live data allowlists · model credentials Class X · agent pricing §8

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L02

````markdown
# BUILD LANE L02 — ACADEMY residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**2 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-academy/**`

## Fenced

agents trade-money pay bank shell

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W5 academy stop on tip — do not regress paper/curriculum/certs seals.

## Read first

1. LANE-STOP-ACADEMY-W5 2. open academy PRs 3. certs WIP ghost

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                            | Done bar (start — tighten from law) |
| ---- | ------------------------------- | ----------------------------------- |
| A0   | Open academy PR merge           | green                               |
| A1   | cert required slugs residual    | #1370 class complete                |
| A1   | bulk scores durable residual    | #1369 class                         |
| A2   | ambassadors residual            | no invent IFC rates                 |
| A2   | paper isolation residual        |                                     |
| A2   | curriculum quality residual     |                                     |
| A3   | spatial residual                |                                     |
| A3   | tournaments blank prizes refuse |                                     |
| A3   | video park                      |                                     |
| A3   | Engine B matrix                 | complete                            |

## Engine B — Promise falsification (UNBOUNDED)

README · lobbies · curriculum · certs · paper · ambassadors · tournaments.

## Engine C — Matrix / attack surface

Tier gates · paper flags · prize config · XP double-award.

## Nitro-only (never invent)

Residency economics · prize amounts · IFC rates §8

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L03

````markdown
# BUILD LANE L03 — P2P residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**3 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-p2p/**`

## Fenced

pay bank trade agents identity-wholesale

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

Do not weaken decide-then-post / re-drive.

## Read first

1. open #1373 p2p stop 2. WIP p2p ghosts 3. escrow ADR

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                              | Done bar (start — tighten from law) |
| ---- | --------------------------------- | ----------------------------------- |
| A0   | Merge #1373 + p2p PRs             | green                               |
| A0   | Ghost clear three WIP             | clear or babysit                    |
| A1   | disputes residual                 | allowlist or refuse                 |
| A1   | instruments residual              | disclose under escrow only          |
| A1   | merchants residual                | badges → limits                     |
| A2   | created timeout re-drive residual |                                     |
| A2   | sweepSettlements residual         |                                     |
| A2   | escrowIntegrity residual          |                                     |
| A3   | reputation/XP residual            |                                     |
| A3   | state machine matrix              | stop note                           |

## Engine B — Promise falsification (UNBOUNDED)

README decide-then-post · re-drive · instruments · disputes · reputation.

## Engine C — Matrix / attack surface

Terminals · moderator · instrument theft · bus.

## Nitro-only (never invent)

p2p:moderate · partners Class X · auto-ruling

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L04

````markdown
# BUILD LANE L04 — PAY residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**4 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-pay/**` · pay recipes · docs/pay

## Fenced

trade bank market p2p agents

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W4/W5 money seals — re-verify only. Do not re-open G4/G3/edge REST without new break.

## Read first

1. open #1384 PAY W5 stop 2. open pay product PRs 3. WIP public-api/subscriptions ghosts

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                            | Done bar (start — tighten from law) |
| ---- | ------------------------------- | ----------------------------------- |
| A0   | Merge #1384 + pay open PRs      | green                               |
| A0   | Ghost clear nitro-pay-w3        | evidence                            |
| A1   | Subscriptions residual          | invoice-and-watch; no pull          |
| A1   | Routing residual                | no invent costs                     |
| A1   | Chargeback wire                 | banner or park                      |
| A2   | Payfac money-path areas         |                                     |
| A2   | Address/ref validation residual |                                     |
| A2   | Gateway KYB refuse until grant  |                                     |
| A3   | Sandbox laundering falsify      |                                     |
| A3   | Edge BASE regression            |                                     |
| A3   | monorepo fixture honesty        | only your suites                    |
| A3   | Engine B full pass              | stop matrix                         |

## Engine B — Promise falsification (UNBOUNDED)

public-rest · payment-service · rails · settlement · subscriptions · merchant.

## Engine C — Matrix / attack surface

WITHHELD scopes · edge strip · idempotency · sandbox vs live · status exits.

## Nitro-only (never invent)

pay:* grants · fee tables · chargeback · acquirer Class X · crypto subs vs protocol · routing §8

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L05

````markdown
# BUILD LANE L05 — TRADE residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**5 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-trade/**` · matching if free

## Fenced

pay bank market p2p agents protocol L11

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

Copy may still be unmounted deliberate; TWAP jobs OFF; do not regress funding/liq seals.

## Read first

1. open #1395 trade W5 stop 2. open trade PRs e.g. #1386 3. W3/W4 trade stops

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                      | Done bar (start — tighten from law)        |
| ---- | ------------------------- | ------------------------------------------ |
| A0   | Merge #1395 + trade PRs   | green                                      |
| A1   | Copy fee-share residual   | #1386 class; mount only deliberate Class M |
| A1   | OTC residual              | stake/§8/last-look                         |
| A1   | MM residual               | no size-blind mid                          |
| A1   | Venue residual            | dark fail-closed                           |
| A2   | Algo OFF respect          | no burst                                   |
| A2   | ccxt residual             | 501 not silent                             |
| A2   | Forex thin                | fundable refused                           |
| A3   | Matching falsify          | if free                                    |
| A3   | Margin-call fail-closed   | no invent numbers                          |
| A3   | Liquidation mark residual | size/initial margin                        |
| A3   | Engine B re-run           | new breaks only                            |

## Engine B — Promise falsification (UNBOUNDED)

README · futures · otc · copy · algo · mm · venue · funding · liq.

## Engine C — Matrix / attack surface

Jobs OFF · mark dark · caller price · double settle · fee-share concurrent.

## Nitro-only (never invent)

leader_share_bps · OTC spreads · leverage · venue keys · options D7

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L06

````markdown
# BUILD LANE L06 — BANK residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**6 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-bank/**`

## Fenced

L07 market · pay · trade · p2p · protocol implement

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W5 SAFE yes parks — earn day-boundary law · fiat/issuer Class X · auto-invest law-only.

## Read first

1. LANE-STOP-L06-BANK-W5 2. open bank PRs 3. reserve reconcile #1372 class

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                 | Done bar (start — tighten from law)    |
| ---- | ------------------------------------ | -------------------------------------- |
| A0   | Open bank PR merge                   | green                                  |
| A1   | reserve reconcile residual           | #1372 class complete                   |
| A1   | ramps residual                       | crypto complete; fiat refuse           |
| A2   | earn day-boundary                    | park Nitro law or implement if decided |
| A2   | loan term-compare residual           |                                        |
| A2   | spaces/earn = ledger proofs residual |                                        |
| A2   | cards residual                       |                                        |
| A3   | auto-invest/business                 | park law-thin                          |
| A3   | true independent funded sum          | park ledger journal need               |
| A3   | README matrix                        | complete                               |

## Engine B — Promise falsification (UNBOUNDED)

README spaces · transfers · earn · loans · cards · ramps · standing orders.

## Engine C — Matrix / attack surface

No local balances · holds · ramp fail-closed · reconcile honesty.

## Nitro-only (never invent)

Earn day-boundary · fiat partner Class X · card issuer · invest rates §8

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L07

````markdown
# BUILD LANE L07 — MARKET residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**7 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-market/**`

## Fenced

L06 bank · pay · shell · token writes

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

vendors done. Commerce Class M still in flight historically — re-derive #1189 state. W5 SAFE no.

## Read first

1. LANE-STOP-L07-MARKET-W5 2. commerce PR status 3. TRK honesty

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                     | Done bar (start — tighten from law) |
| ---- | ---------------------------------------- | ----------------------------------- |
| A0   | Commerce Class M to green or honest park | re-derive open PR                   |
| A1   | one-time purchase residual               | commission refuse blank             |
| A1   | listings honesty residual                |                                     |
| A2   | concurrent create wrap residual          | parked                              |
| A2   | subscriptions product                    | park no law                         |
| A2   | ranking DIRECTION 8                      | park                                |
| A3   | commission bps                           | Nitro value only                    |
| A3   | scopes+edge residual                     |                                     |
| A3   | eligibility computed residual            |                                     |
| A3   | README matrix                            | complete                            |

## Engine B — Promise falsification (UNBOUNDED)

README vendors · slots · listing · commerce.

## Engine C — Matrix / attack surface

stake unavailable · commission conservation · public refuse codes.

## Nitro-only (never invent)

commission bps · ranking DIRECTION 8 · subscription past-due law

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L08

````markdown
# BUILD LANE L08 — NOTIFY residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**8 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-notify/**`

## Fenced

L11 shell · agents · identity wholesale

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W5 SAFE yes — many pin tests; do not regress multi-replica SMS / reaper / kill-switch.

## Read first

1. LANE-STOP-L08-W5 2. open notify PRs 3. v22.alerts / i18n free residual

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                | Done bar (start — tighten from law) |
| ---- | ----------------------------------- | ----------------------------------- |
| A0   | Open notify PR merge                | green                               |
| A1   | pin tests residual complete         | defaults/caps/lease/kill            |
| A1   | v22.alerts MVP residual             | dark refuse                         |
| A2   | channel credentials refuse residual |                                     |
| A2   | refusal-code matrix residual        | #1392 class                         |
| A2   | multi-replica residual              |                                     |
| A3   | event-wiring Class B                | no growth                           |
| A3   | free infra.i18n for alert copy      | optional                            |
| A3   | boot refusal residual               |                                     |
| A3   | README matrix                       | complete                            |

## Engine B — Promise falsification (UNBOUNDED)

README channels · retry · consent · alerts · boot · reaper · kill-switch.

## Engine C — Matrix / attack surface

bus · idempotent delivery · PII · rate limits · fan-out kill.

## Nitro-only (never invent)

gateway credentials Class X

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L09

````markdown
# BUILD LANE L09 — INDEXER residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**9 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-indexer/**`

## Fenced

protocol/chain/dex implement

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

Custody structural — no keys/writes/ledger posts.

## Read first

1. open #1396 indexer stop 2. open indexer PRs 3. cold start startHeight #1364

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                    | Done bar (start — tighten from law)     |
| ---- | --------------------------------------- | --------------------------------------- |
| A0   | Merge #1396 + indexer PRs               | green                                   |
| A1   | cold start startHeight residual         | #1364 class complete                    |
| A1   | dark/dead chain residual                |                                         |
| A1   | permissionless API residual             |                                         |
| A2   | parent unlink residual                  |                                         |
| A2   | reorg/idempotent residual               |                                         |
| A2   | address case residual                   |                                         |
| A3   | maker-case monorepo red                 | only if your suite — no dual-write bank |
| A3   | kill-switch residual                    |                                         |
| A3   | sovereignty tests residual              |                                         |
| A3   | README matrix                           | complete                                |
| A3   | tracker owner honesty if shehzad on row | babysit only                            |

## Engine B — Promise falsification (UNBOUNDED)

README sovereignty · API · staleness · ingest · adapters · tests.

## Engine C — Matrix / attack surface

PublicClient only · halt · cursor · permissionless mirror.

## Nitro-only (never invent)

Mainnet RPC Class X

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L10

````markdown
# BUILD LANE L10 — WS residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**10 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-ws/**`

## Fenced

trade/matching secrets · L11 · edge mount

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

No INTERNAL_SERVICE_SECRET / EDGE_PRINCIPAL / DATABASE.

## Read first

1. open #1352 WS stop 2. open WS PRs 3. isolation tests #1342

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                               | Done bar (start — tighten from law) |
| ---- | ---------------------------------- | ----------------------------------- |
| A0   | Merge #1352 + WS PRs               | green                               |
| A1   | public/private isolation residual  | #1342                               |
| A1   | bus-down ready residual            |                                     |
| A1   | private socket die residual        |                                     |
| A2   | tape no leak residual              |                                     |
| A2   | empty books listed residual        |                                     |
| A2   | NATS reconnect residual            | park or fix                         |
| A3   | JWT query ticket redesign          | park or design                      |
| A3   | per-IP rate limit                  |                                     |
| A3   | credential scan zero               |                                     |
| A3   | README matrix                      | complete                            |
| A3   | architecture not on trade/matching | holds                               |

## Engine B — Promise falsification (UNBOUNDED)

README isolation · depth · tape · bus · non-goals.

## Engine C — Matrix / attack surface

anonymous browser · no ledger · no order entry · fan-out.

## Nitro-only (never invent)

None typical

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L11

````markdown
# BUILD LANE L11 — SHELL residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**11 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`vendor/upstream-exchange/05_Web_Front/**` desk · shell gates

## Fenced

L16 bulk vendor · service backends

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W5 SAFE no until tip Tests unblocked — babysit shell greens; do not regress decimal/shape/i18n/candles.

## Read first

1. LANE-STOP-L11-W5 2. open shell PRs #1358 #1335 etc 3. L16 split

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                  | Done bar (start — tighten from law) |
| ---- | ------------------------------------- | ----------------------------------- |
| A0   | Open shell PR merge when tip allows   | green                               |
| A0   | L16 same-file war check               | one writer                          |
| A1   | chart candles refuse JSON number OHLC | #1358 class                         |
| A1   | fee/buy i18n residual                 | #1335 class                         |
| A1   | float money refuse residual           |                                     |
| A2   | feedLive honesty residual             |                                     |
| A2   | brand baseline residual               |                                     |
| A2   | support form residual                 | socket                              |
| A3   | hotkeys/subaccounts multi-book        | waits identity                      |
| A3   | mobile park                           |                                     |
| A3   | no green unwired                      |                                     |
| A3   | stop note when tip unblocked          | SAFE yes                            |

## Engine B — Promise falsification (UNBOUNDED)

UI live/settled claims · float money · candle numbers · i18n.

## Engine C — Matrix / attack surface

lang packs · API errors · desk hot path.

## Nitro-only (never invent)

CDN/go-live Class X

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L12

````markdown
# BUILD LANE L12 — IDENTITY residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**12 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-identity/**`

## Fenced

notify · invent pay grants · p2p moderate mint

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W5 SAFE no until Tests unblocked by sibling — babysit open identity PRs; do not dual-write agents/pay to unstick.

## Read first

1. LANE-STOP-IDENTITY-W5 2. open #1382 passkey withdraw etc 3. encrypted KYC vault #1348

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                              | Done bar (start — tighten from law) |
| ---- | --------------------------------- | ----------------------------------- |
| A0   | Babysit identity open PR cluster  | green when tip allows               |
| A1   | passkey unlock withdraw residual  | #1382 class                         |
| A1   | domain list blocks residual       | #1326 class                         |
| A1   | encrypted KYC vault residual      | #1348 class; vendor Class X         |
| A2   | TOTP encrypt-at-rest residual     |                                     |
| A2   | WebAuthn step-up residual         |                                     |
| A2   | freeze/keys residual              |                                     |
| A3   | affiliate §8 payout               | park Nitro                          |
| A3   | domain_whitelist enforce residual |                                     |
| A3   | pay:* WITHHELD remains            | never invent grant                  |
| A3   | README matrix residual            |                                     |
| A3   | SAFE yes when PRs merged          |                                     |

## Engine B — Promise falsification (UNBOUNDED)

auth · MFA · webauthn · kyc · rank · apiKeys · subAccounts · affiliates · vault.

## Engine C — Matrix / attack surface

session · cross-user · freeze · step-up withdraw · bot scopes.

## Nitro-only (never invent)

KYC vendor Class X · affiliate §8 · pay:* grants

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L13

````markdown
# BUILD LANE L13 — TOKEN residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**13 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-token/**`

## Fenced

market stake writes · protocol minter

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

Never fail-open stake rescale. W5 SAFE yes parks emission §8 and flywheel sockets.

## Read first

1. LANE-STOP-TOKEN-W5 2. open token PRs 3. empty-staker / crash residual

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                  | Done bar (start — tighten from law) |
| ---- | ------------------------------------- | ----------------------------------- |
| A0   | Open token PR merge                   | green                               |
| A1   | empty-staker yield residual           |                                     |
| A1   | mint post-then-row crash residual     |                                     |
| A1   | stake round-trip residual             |                                     |
| A2   | yield/buyback socket honesty residual |                                     |
| A2   | cron mint kill residual               |                                     |
| A2   | governance concurrency residual       |                                     |
| A3   | emission curve                        | park §8                             |
| A3   | engine residual after empty sweep     | operator schedule                   |
| A3   | README matrix residual                |                                     |

## Engine B — Promise falsification (UNBOUNDED)

§4.3 · staking · emissions · governance · operator surfaces.

## Engine C — Matrix / attack surface

fail-closed stake · double distribute · proposals.

## Nitro-only (never invent)

emission curve §8

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L14

````markdown
# BUILD LANE L14 — LEDGER residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**14 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`services/svc-ledger/**` · ledger-client residual when carded

## Fenced

pay/trade/bank call sites those lanes

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

Never bypass recipes. W5 stop open #1361 — purpose on balance #1355.

## Read first

1. open #1361 ledger stop 2. open ledger PRs 3. chargeback coord L04

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                          | Done bar (start — tighten from law) |
| ---- | ----------------------------- | ----------------------------------- |
| A0   | Merge #1361 + ledger PRs      | green                               |
| A1   | purpose on balance residual   | #1355 class complete                |
| A1   | freeze reason residual        |                                     |
| A1   | reconcile residual            | real not simulated                  |
| A2   | recipe pins residual          | burn/refund/fee                     |
| A2   | chargeback wire               | banner + L04                        |
| A2   | edge+admin reconcile proxy    | park or implement carefully         |
| A3   | money property gates residual |                                     |
| A3   | totalsByAsset residual        |                                     |
| A3   | README matrix                 | complete                            |

## Engine B — Promise falsification (UNBOUNDED)

recipes · freeze · reconcile · accounts · purpose · tests.

## Engine C — Matrix / attack surface

dual-book · number money · holds · operator authZ · purpose integrity.

## Nitro-only (never invent)

treasury freeze policy Class X

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L15

````markdown
# BUILD LANE L15 — BOARD+TOOLING residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**15 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`tooling/**` · docs/ops meters · tracker honesty · stranded path-clean branches

## Fenced

L01–L14 product bodies

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W5 SAFE no mid-wave parks — FREEZE snapshot law #1399 · claim-check residual #1360.

## Read first

1. LANE-STOP-L15-W5 2. open tooling PRs 3. fabricated-money gate #1330

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                       | Done bar (start — tighten from law) |
| ---- | ------------------------------------------ | ----------------------------------- |
| A0   | Open tooling PR merge                      | green                               |
| A1   | claim-check residual pack complete         | #1360 class                         |
| A1   | FREEZE snapshot vs cold-start law residual | #1399 class                         |
| A1   | fabricated-money gate residual             | #1330 class                         |
| A2   | AGENTS count handoff L01 residual          |                                     |
| A2   | pay evm-chain unreported residual          | L04 handoff                         |
| A2   | venue-vault requires residual              | features.mjs                        |
| A2   | socket over-fence residual                 |                                     |
| A3   | gh files truncate residual                 |                                     |
| A3   | stranded branch land                       | path-clean                          |
| A3   | wt:gc residual                             |                                     |
| A3   | SAFE yes when parks clear                  |                                     |

## Engine B — Promise falsification (UNBOUNDED)

Falsify claim-check · gc · thrift absence · scans · FREEZE · pre-push.

## Engine C — Matrix / attack surface

false clear · false free · CI skips · header honesty · board-delta.

## Nitro-only (never invent)

None typical

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---

# L16

````markdown
# BUILD LANE L16 — VENDOR residual · wave 6 · long cook · go all out

You are Claude Code on INTAFACED (`~/projects/Sovereign` → `Phantom-X-007/intafaced`).
Nitro is AFK. **Token cost is not a constraint for residual work.**
**16 of 16** path-walled lanes are live. You own **only** your wall.

## 0 · Auth + tip ritual (every cycle)

```
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:/opt/homebrew/bin:$PATH"
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
cd /Users/Nitro/projects/Sovereign
git fetch origin
git log -1 --oneline origin/main
gh pr list --state open --limit 60
node tooling/ci/claim-check.mjs <paths>   # unsandboxed
```

- Never print GH_TOKEN. Unsandbox gh / claim-check.
- **Never edit main checkout.** `pnpm wt feat/w6-<lane>-<slice>` from origin/main.
- Thrift deleted on tip — ignore stale HARD thrift.
- Paste-time tip: `8da2c561` — **tip wins**. Stop notes are hypotheses.
- Open PRs (re-derive): ~60 open — babysit first: stop PRs #1384 PAY #1395 TRADE #1396 INDEXER #1352 WS #1361 LEDGER #1373 P2P · market #1189/#1387 commerce · identity cluster · shell/ws/notify tests · #1177 Shehzad · dependabot holds — re-derive
- Fan-out: judgment strong; bulk harvest parallel; no escalate-on-uncertainty thrash. Class M always adversarial.
- **Wave 6:** Wave 5 largely banked with parked residuals + many open stop/product PRs. **Babysit your wall's open PRs first** (including docs stop PRs). Fix monorepo red only if **your** suite broke tip — do not dual-write sibling services to clear their red. Do not invent §8.

## Unit card (mandatory before code)

1. Promise quoted (file:line / ADR / SPEC / W5 stop)
2. Reachable break
3. **Done bar**
4. Class N / P / M / X
5. Paths (packages one-writer if touched)
6. RED test first
7. Collision list vs open PR files

### Class M body (when money)

Self-audit: money path? ledger recipes? no balances outside ledger? no money in number?  
Adversarial: replay · crash mid-write · hostile caller · dark dependency — PR body before merge.

## Parallel recipe

1. **8–12 read-only subagents** first half hour
2. Rank: **merge open PRs on wall** → W5 parked → new residual → never greenfield without Done bar
3. **3–5 worktrees hot**
4. Next unit while CI runs
5. Compact → rebuild from git/gh only
6. Cross-service: **contracts/events PR first**
7. Tracker: mountain-event only
8. `pnpm verify` before push; CI seal
9. PR titles: plain words for Nitro

## Loop

```
while true:
  fetch tip · open PRs · path-intersect · claim-check
  merge your greens
  pick highest CLEAR unit with unit card
  RED → implement → verify → PR → adversarial if M → merge
  start next stream while CI runs
  after compact: rebuild from git/gh only
```

## Banned stops

todo empty · free=0 · thrift · "want me to continue?" · wait for Nitro except Class X / blank §8 / grant authority · idle without real collision · "fixing" sibling suites outside your wall

## Real stop

≥8 Engine A shipped or parked with pick-up · Engine B chapter pass · stop note docs PR · nothing uncommitted →
`docs/LANE-STOP-<ID>-W6-2026-08-09.md` +

```
LANE: <ID> wave 6
shipped: #… plain words
in flight: …
parked: … + why
Nitro must decide: … or none
SAFE TO CLOSE: yes/no
tip: <sha>
```

## Exclusive wall (YOURS)

`vendor/**` except L11 desk in flight

## Fenced

L11 desk UX · TS service money

**Siblings W6:** L01 AGENTS · L02 ACADEMY · L03 P2P · L04 PAY · L05 TRADE · L06 BANK · L07 MARKET · L08 NOTIFY · L09 INDEXER · L10 WS · L11 SHELL · L12 IDENTITY · L13 TOKEN · L14 LEDGER · L15 BOARD+TOOLING · L16 VENDOR-SUPPLY.

## Sealed — do not re-ship (re-verify)

W5 SAFE yes — HOLD #1142/#1146 · NOTICE · Grade C admin residual.

## Read first

1. LANE-STOP-L16-W5 2. dependabot holds 3. money-scan allowlist #1338

## Engine A — Ranked residual (≥8 rows, Done bar each)

| Prio | Unit                                 | Done bar (start — tighten from law) |
| ---- | ------------------------------------ | ----------------------------------- |
| A0   | L11 file split check                 | one writer                          |
| A0   | #1142/#1146 compile-proof or close   | no blind merge                      |
| A1   | money-scan allowlist header residual | #1338 class                         |
| A1   | Grade C admin controllers residual   | dual-book                           |
| A2   | NOTICE regenerate residual           | no invent generator                 |
| A2   | wallet_rpc deps residual             |                                     |
| A2   | framework deps residual              |                                     |
| A3   | Boot 2/3 upgrade residual            | multi-month park                    |
| A3   | scan ratchet residual                | no growth                           |
| A3   | stop note supply matrix              |                                     |

## Engine B — Promise falsification (UNBOUNDED)

scan scripts · barriers · known writes · Dependabot policy · allowlist headers.

## Engine C — Matrix / attack surface

HIGH advisories · DAO mutators · mainnet constants · mint paths.

## Nitro-only (never invent)

Licence/counsel Class X

GO — tip ritual · babysit open PRs · harvest · unit cards · multi-stream · no second briefing.
````

---
