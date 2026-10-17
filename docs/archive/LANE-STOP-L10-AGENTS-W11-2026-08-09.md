# LANE-STOP L10 AGENTS · wave 11 product-velocity · 2026-08-09

```
LANE: L10 wave 11 product-velocity
shipped: #1615 killed agent stays disabled after redeploy
in flight: none
parked: portfolio/launch/risk/coach/growth — law-thin · live trade/pay/copy/ops allowlists Class X · model credentials Class X · agent pricing §8 magnitudes · metering-off usage_records dual-write (product ruling only) · agents.premiumTiers NOT_ENFORCED · crew-events half-wire (ADR D-S-13 owner) · doctrine “10 agents” vs Stage-1 five (board care only) · admin setEnabled UI (ops can flip DB flag; no product admin surface required this wave)
Nitro must decide: none for craft
SAFE TO CLOSE: yes
tip: 1bb4243a
```

## Unit cards (wave 11)

| Unit                    | Done bar                                             | Class | Outcome                                                                                                   |
| ----------------------- | ---------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------- |
| A0 open agents PR merge | green merge                                          | N     | none open at cook start (siblings only — identity/site/ledger/protocol/dependabot; none touch svc-agents) |
| A1 navigator residual   | tool-calling inside guardrails; hostile tools refuse | P     | **holds** — re-verified                                                                                   |
| A1 scanner residual     | ranked signals by tier; dark allowlist unbilled      | P     | **holds** — re-verified                                                                                   |
| A1 merchant residual    | approval-rate watch without invent rates             | P     | **holds** — re-verified                                                                                   |
| A2 hostile money tools  | fleet refuse fleet-wide                              | N     | **holds** — re-verified (#1433 + #1550 bank.withdraw)                                                     |
| A2 metering-off         | audit-only; settle halt leftover windows             | M/N   | **holds** — re-verified (#1550)                                                                           |
| A2 kill-switch residual | enabled=false sticks across boot redeploy            | N     | **shipped #1615** (W10 miss — boot rewrote enabled=true)                                                  |
| A3 v2 / Class X / §8    | park                                                 | L6    | **parked**                                                                                                |
| A3 Engine B pass        | this note                                            | N     | **this note**                                                                                             |

## Engine A residual board

| Prio  | Unit                                                     | Outcome                                                |
| ----- | -------------------------------------------------------- | ------------------------------------------------------ |
| A0    | Open agents PR merge                                     | empty at cook                                          |
| A1–A2 | Stage-1 product Done bars (5 agents + metering + matrix) | **holds** on tip after #1615                           |
| A2    | Kill enable preserve                                     | **#1615** — conflict path no longer overwrites enabled |
| A3    | portfolio/launch/risk/coach/growth                       | **parked** law-thin                                    |
| A3    | live allowlists / model creds / pricing                  | **parked** Class X / §8                                |
| A3    | mountain-event tracker done                              | **not** — stay not-done until live grounded env        |
| A3    | Engine B pass                                            | **this note**                                          |

## Engine B — promise falsification (RAN-IT)

Base: `origin/main` @ `1bb4243a` (includes #1615).

| Chapter            | Verdict                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Navigator          | **hold** — metered `runSession`; hostile tools refuse before execute; money denylist                   |
| Scanner            | **hold** — ranked fixtures; dark/blank refuse; billed zero on refuse                                   |
| Merchant           | **hold** — approval-rate watch; no invent rates; dark pay refuse                                       |
| Metering           | **hold** — kill-switch no `usage_records` / no `feeCharge` on settle when off (#1550)                  |
| Kill enable        | **hold** — #1615: ON CONFLICT preserves `enabled`; openSession refuses when disabled after re-register |
| Guardrails / fleet | **hold** — hard money denylist; 5/5 boot-register; matrix mounts                                       |
| Readiness          | **hold** — mock residual honest; fleet card present                                                    |

**Proof (pure suite, no Docker):** worktree pre-merge `pnpm --filter @intafaced/svc-agents test` → **384 passed**, 1 skipped (`runtime.test.ts` Postgres — CI sealed on #1615).  
CI on #1615: Doctrine gates · Tests · Typecheck & build · Definition of Done · Prettier · Gitleaks · Dependency audit — **all green**.

## Engine C — attack surface

| Surface               | Status                                                          |
| --------------------- | --------------------------------------------------------------- |
| money tool free       | hard denylist + undeclared refuse; product parse refuses inject |
| fake production ready | process ready + mock residual; not production inference         |
| rate invent           | blank rate refuses; §8 magnitudes Nitro-only                    |
| kill reboot wipe      | sealed #1615                                                    |

## Sealed (do not re-ship)

W6: #1425 · #1426 · #1427 · #1428 · #1429 · #1433 · #1434 · #1436  
W9: #1550 · stop #1564  
W10: re-verify #1577  
W11: **#1615** kill enable preserve · this stop

## Parked pick-up

1. Live grounded tools (trade/pay/copy/ops allowlists) — Class X.
2. Portfolio / launch / risk / coach / growth — product law first.
3. Metering-off dual-write back to `usage_records` — product ruling only.
4. Wire `agents.premiumTiers` as real refuse — only with premium product definition.
5. Doctrine “10 agents” vs Stage-1 five if board care.
6. `crew-events` wire — ADR D-S-13 owner (deliberately unwired).
7. Admin `setEnabled` product surface — optional; DB flag + #1615 is enough for ops kill.

## Wall

`services/svc-agents/**` only. claim-check clear vs open PRs. No dual-write siblings. Class X never invented. No pad after residual-empty honesty.
