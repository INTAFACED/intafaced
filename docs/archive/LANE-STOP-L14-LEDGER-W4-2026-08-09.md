# LANE STOP — L14 LEDGER · wave 4 · 2026-08-09

```
LANE: L14 LEDGER wave 4
shipped: #1274 operator real reconcile · #1282 freeze reason floor · (+ in-flight test/docs PRs below)
in flight: #1295 loans package tests (CI blocked by unrelated svc-protocol on-chain flake) · #1299 bank package tests · #1304 recipe matrix
parked: edge+admin reconcile proxy (L15/ops) · treasury freeze policy Class X · chargeback wire into svc-pay (L04)
Nitro must decide: none (Class X freeze policy only if he wants a product rule change)
SAFE TO CLOSE: yes — wall residual banked; babysit in-flight PRs or leave for next cycle
tip: re-derive origin/main (this file banks decisions; machine tip wins)
```

## Shipped this session (merged)

| PR        | Plain words                                                                                                                                           | Class |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **#1274** | Operator can run a **real** reconcile over HTTP (`POST /operator/reconcile`, treasury+MFA). Broken chain no longer reports length 0 (half-green fix). | **M** |
| **#1282** | Freeze reason must be usable (≥12 chars) on tRPC — same floor as operator HTTP.                                                                       | N     |

## In flight (open at stop)

| PR        | Plain words                                               | Status at stop                                                                                                                             |
| --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **#1295** | Package tests pin the four loan-recipe rewrite bugs       | **CI red** on `svc-protocol` `lending-oracle.onchain.test.ts` Unhealthy borrow — **not** our loans tests (they passed 9/9 in the same log) |
| **#1299** | Package tests for bank transfer + earn conservation/keys  | CI running / merge when green                                                                                                              |
| **#1304** | `RECIPES.md` matrix of all 49 recipes + registry tripwire | CI running / merge when green                                                                                                              |

## Engine A status (sealed vs residual)

| Prio | Unit                        | Verdict                                                                                |
| ---- | --------------------------- | -------------------------------------------------------------------------------------- |
| A0   | Open PR intersect           | clear on svc-ledger (market recipes fenced on #1189 / L07)                             |
| A1   | spend/history               | **SEALED** #1170 — mounted S2S + tRPC type, cap refuse honest                          |
| A1   | freeze/unfreeze real        | **SEALED** durable DB + operator HTTP + #1282 reason floor                             |
| A1   | reconcile full or simulated | **LEDGER HALF SEALED** #1274 full three-check; admin still simulated until L15 proxies |
| A2   | chargeback + banner         | **SEALED** on tip (#800 era); NOT wired to pay (L04 residual, intentional)             |
| A2   | idempotent posts            | **SEALED** DB key length + post re-drive law                                           |
| A2   | money property gates        | **SEALED** `money.property.test.ts`                                                    |
| A2   | recipe residual             | loan + bank package tests shipping (#1295/#1299)                                       |
| A3   | totalsByAsset zero          | **SEALED** inside `runReconciliation`                                                  |
| A3   | verifyChain                 | **SEALED**                                                                             |
| A3   | README matrix               | **SHIPPING** #1304                                                                     |

## Engine B — promise falsification (chapter pass)

Falsified against tip + #1274:

- README claimed on-demand admin reconcile → **was** only cron + unmounted tRPC → **fixed** operator HTTP.
- tRPC broken-chain `chainLength: 0` → **half-green** → **fixed** length-so-far + `chainBrokenAt`.
- Freeze reason min(1) vs operator min(12) → **aligned** #1282.
- Chargeback “no recipe” ADR gap → already filled with owner banner.
- Loan stubs → already rewritten; package tests pin the four bugs.

No new greenfield recipes invented.

## Engine C — attack surface

- Operator reconcile: JWT + `admin:treasury` + MFA only; service secret cannot open door (Class M adversarial PASS on #1274).
- Dual-book owner id space: sealed on tip (0005 + tests).
- Number money: gates + property tests sealed.
- Holds purpose: CHECK + purposed-locks tests sealed.

## Parked with pick-up

1. **L15 / ops:** edge `LedgerOperatorCall` path union + admin BFF + replace simulated reconcile button with live call to `/operator/reconcile`.
2. **L04:** wire chargeback recipes when card rail exists (banner already present).
3. **Class X:** treasury freeze _policy_ content (who may freeze, auto-thaw rules) — never invent.
4. **#1295:** re-run CI or rebase after protocol on-chain test is green; our suite is innocent.

## Wall discipline

Exclusive paths only: `services/svc-ledger/**` · `packages/ledger-client/**` (not market recipes). No pay/trade/bank call sites.
