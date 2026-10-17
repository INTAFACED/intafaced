# Full findings — 2026-07-29

**Baseline:** `a19e337` · **Mode:** multi-agent layers L1–L11 + orchestrator adversarial re-check  
**Claim tags:** `[VERIFIED]` re-read in orchestrator · `[AGENT]` from explore pass · `[FIXED]` this branch

Severity: **P0** money/trust open door · **P1** serious · **P2** structural · **P3** hygiene

---

## Confirmed P0 / high (action)

| ID           | Sev | Title                                                                     | Status                                                      |
| ------------ | --- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| L6-1         | P0  | `svc-protocol` built router but never registered `/trpc`                  | **FIXED** this branch                                       |
| L2-2 / L11-2 | P0  | `rank.awardXp` on `identity:write` (every session)                        | **FIXED** → `serviceProcedure`                              |
| L2-1         | P0  | Pay merchant **mutations** missing ownership (capture/refund/payout IDOR) | **FIXED** + tests                                           |
| L1-1 / L9-1  | P1  | Brand + format CI red after vendor #73                                    | **FIXED** (allowlist ADRs/audit; prettier ignore `vendor/`) |
| L5-1 / L5-2  | P1  | dex `INDEXER_URL`→4012 (protocol), `MATCHING_URL`→4004 (trade)            | **FIXED** → 4013 / 4005                                     |
| L2-3 / L11-4 | P1  | Unauth `/internal/*` on identity/token/p2p                                | **FIXED** service HMAC                                      |
| L8-1         | P1  | Tracker false `done` on protocol.smart-accounts                           | **FIXED** → `ready` + honest note                           |

## P1 money-path residual — **FIXED Audit V2**

| ID   | Sev | Title                                          | Status                                                    |
| ---- | --- | ---------------------------------------------- | --------------------------------------------------------- |
| L3-1 | P1  | Withdraw reverse then status update not atomic | **FIXED** — stamp failure_code then `finalizeRailRefusal` |
| L3-2 | P1  | Token stake ledger-first without claim row     | **FIXED** — `pending` claim → ledger → `active`           |
| L3-3 | P1  | Earn deposit same claim gap                    | **FIXED** — same pending pattern                          |

## Confirmed P2 (parked)

| ID          | Title                                              |
| ----------- | -------------------------------------------------- |
| L1-2 / L1-3 | Dual-book stake/earn principal vs ledger           |
| L3-4        | P2P escrow one pot per user+asset (no purpose key) |
| L3-5        | Earn + token share `userStake`                     |
| L2-4        | Region header not in principal HMAC                |
| L2-6        | Shared S2S secret, no body bind                    |
| L2-7        | P2P trade/dispute get any authenticated reader     |
| L5-7        | Host-publishes S2S ports in compose                |
| L5-8        | RUNNING.md port table stale                        |
| L7-3        | Protocol UI copy claims indexer absent             |
| L8-2        | tracker:check only path-exists for `done`          |
| L9-2        | Vendor as money product would violate §0.6         |

## Clean (re-verified)

- Money posts via recipes only (production services)
- Protocol plane: no ledger write; custody-scan green
- #50 ledger auth, #55 matching writes, #62 bank jobs, #75 depth allocate — still fixed
- Purpose-keyed holds P0-3 implemented in code (decision doc stale)
- Edge does not route ledger/matching
- Web CEX path real; WS no secrets
- `pnpm` turbo test suite green at baseline (83 tasks); DoD failed only brand

## Machine truth after fixes (this branch)

| Check                                     | Result                                               |
| ----------------------------------------- | ---------------------------------------------------- |
| brand-scan                                | **clean**                                            |
| format:check                              | **clean** after ignore vendor + format touched files |
| identity tests                            | **84 passed** (+ awardXp service-only)               |
| pay tests                                 | **221 passed** (+ mutation ownership)                |
| typecheck identity/pay/protocol/token/p2p | **pass**                                             |

Full `pnpm verify` re-run recommended before merge.
