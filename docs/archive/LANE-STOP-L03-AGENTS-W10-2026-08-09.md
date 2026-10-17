# LANE-STOP L03 AGENTS · wave 10 product-velocity · 2026-08-09

```
LANE: L03 wave 10 product-velocity
shipped: none this wave (product craft residual-empty on tip after W9 #1550 / #1564)
in flight: none
parked: portfolio/launch/risk/coach/growth — law-thin · live trade/pay/copy/ops allowlists Class X · model credentials Class X · agent pricing §8 magnitudes · metering-off usage_records dual-write (product ruling only) · agents.premiumTiers NOT_ENFORCED · crew-events half-wire (ADR D-S-13 owner) · doctrine “10 agents” vs Stage-1 five (board care only)
Nitro must decide: none for craft
SAFE TO CLOSE: yes
tip: 670a1162
```

## Unit cards (wave 10)

| Unit                        | Done bar                                             | Class | Outcome                                                                                             |
| --------------------------- | ---------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------- |
| A0 open agents PR merge     | green merge                                          | N     | none open at cook start (only #1177 Shehzad · #1575 CI heal · dependabot — none touch `svc-agents`) |
| A1 navigator residual       | tool-calling inside guardrails; hostile tools refuse | P     | **holds** — re-verified                                                                             |
| A1 scanner residual         | ranked signals by tier; dark allowlist unbilled      | P     | **holds** — re-verified                                                                             |
| A1 merchant residual        | approval-rate watch without invent rates             | P     | **holds** — re-verified                                                                             |
| A2 support residual         | KB + account-state grounded; no invent balances      | P     | **holds** — re-verified                                                                             |
| A2 copy-intel residual      | audited leader stats write path                      | P     | **holds** — re-verified                                                                             |
| A2 metering-off residual    | audit-only holds; settle halt                        | M/N   | **holds** — re-verified (#1550)                                                                     |
| A2 fleet matrix residual    | boot-register honesty 5/5                            | N     | **holds** — re-verified                                                                             |
| A3 v2 agents / Class X / §8 | park                                                 | L6    | **parked** (see list)                                                                               |
| A3 Engine B pass            | this note                                            | N     | **this note**                                                                                       |

## Engine A residual board

| Prio  | Unit                                                     | Outcome                                                                                  |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A0    | Open agents PR merge                                     | empty                                                                                    |
| A1–A2 | Stage-1 product Done bars (5 agents + metering + matrix) | **holds** on tip; no CLEAR craft unit under law                                          |
| A3    | portfolio/launch/risk/coach/growth                       | **parked** law-thin                                                                      |
| A3    | live allowlists / model creds / pricing                  | **parked** Class X / §8                                                                  |
| A3    | mountain-event tracker done                              | **not** — mountains stay not-done until live grounded env (tracker notes already honest) |
| A3    | Engine B pass                                            | **this note**                                                                            |

## Engine B — promise falsification (RAN-IT on tip worktree)

Base: `origin/main` @ `670a1162` (after rebase from paste tip `ed42f91d` / cook tip `2ec1ac0c`).

| Chapter             | Verdict                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Navigator           | **hold** — metered `runSession`; hostile tools refuse before execute; money denylist                     |
| Scanner             | **hold** — ranked fixtures; dark/blank refuse; billed zero on refuse                                     |
| Merchant            | **hold** — approval-rate watch; no invent rates; dark pay refuse                                         |
| Support agent       | **hold** — KB + account-state grounded; money tools escalate/refuse; no balance field                    |
| Copy-intel          | **hold** — audited leader stats write; money-write refuse                                                |
| Metering            | **hold** — kill-switch no `usage_records` / no `feeCharge` on settle when off                            |
| Guardrails          | **hold** — `FLEET_HARD_MONEY_WRITE_TOOLS` includes `bank.withdraw`; parse refuse all `PRODUCT_AGENT_IDS` |
| Fleet matrix / boot | **hold** — 5/5 factories boot-register                                                                   |
| Readiness           | **hold** — mock residual honest; fleet card present                                                      |

**Proof (pure suite, no Docker):** `pnpm exec vitest run` in `services/svc-agents` → **382 passed**, 1 skipped (`runtime.test.ts` Postgres integration — CI path).  
Focused honesty pack (20 files): **148/148** including hostile fleet pin, dark refuse zero, money-scope, session-run for all five factories, metering-off request-id, settleSession mount.

## Engine C — attack surface

| Surface               | Status                                                          |
| --------------------- | --------------------------------------------------------------- |
| money tool free       | hard denylist + undeclared refuse; product parse refuses inject |
| fake production ready | process ready + mock residual; not production inference         |
| rate invent           | blank rate refuses; §8 magnitudes Nitro-only                    |

## Sealed (do not re-ship)

W6: #1425 · #1426 · #1427 · #1428 · #1429 · #1433 · #1434 · #1436  
W9: #1550 · stop #1564  
W10: re-verify only — no product delta

## Parked pick-up

1. Live grounded tools (trade/pay/copy/ops allowlists) — Class X.
2. Portfolio / launch / risk / coach / growth — product law first.
3. Metering-off dual-write back to `usage_records` — product ruling only.
4. Wire `agents.premiumTiers` as real refuse — only with premium product definition.
5. Doctrine “10 agents” vs Stage-1 five if board care.
6. `crew-events` wire — ADR D-S-13 owner (deliberately unwired; two-line mount is not free without owner close).

## Wall

`services/svc-agents/**` only. claim-check clear vs open PRs. No dual-write siblings. Class X never invented. No pad after residual-empty honesty.
