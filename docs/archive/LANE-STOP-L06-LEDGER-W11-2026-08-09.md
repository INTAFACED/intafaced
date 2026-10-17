# LANE STOP — L06 LEDGER open bank · wave 11 · 2026-08-09

```
LANE: L06 LEDGER wave 11 product-velocity
shipped: #1593 purpose pad belt — tab/NBSP cannot open a second pot
in flight: none
parked: S2S body-bind require (pay still unbound — L01) · chargeback wire (pay) · edge+admin reconcile proxy (edge/ops) · sibling purpose parsers (pay/trade/bank/p2p) · history pagination §13 · chain sharding §13 · assets.decimals product policy · treasury freeze policy Class X · trade.mm-bot settleFill wiring (trade) · futures product-complete (Denon invent-risk)
Nitro must decide: treasury freeze policy (Class X) — or none for this wall
SAFE TO CLOSE: yes
tip: re-derive origin/main (machine tip wins; paste-time tip was stale)
```

## Verdict

**Product residual-empty on exclusive wall** (`services/svc-ledger/**` · `packages/ledger-client/**`) after open-PR bank merge + Engine B re-verify under tip.

Wave 11 was open-PR bank first. The only ledger-path open PR at lane start was **#1593** (purpose pads tab/NBSP). It is **merged**. W10 residual-empty (#1587) had sealed freeze/recipes/reconcile/mint-burn; it had **missed** the DB `btrim` vs JS `.trim()` pad gap — that is what #1593 closed.

## Unit card for #1593 (shipped)

| Slot      | Content                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| Promise   | purpose identity = trimmed claim (0011 comment + `accountPurpose`)                             |
| Break     | bare `btrim(purpose)` is space-only → raw SQL `order:x\t` / NBSP opens second pot; recon green |
| Done bar  | raw INSERT tab/NBSP/tab-only → CHECK refuse; client keys equal bare claim                      |
| Class     | **M** (pot identity / dual book)                                                               |
| Paths     | `services/svc-ledger/**` · `packages/ledger-client/**` (one writer)                            |
| RED first | purposed-locks pins + ledger.test purpose pads                                                 |
| Collision | claim-check owned the wall until merge; clear after                                            |

## Engine A (re-derived after #1593)

| Prio | Unit                           | Verdict                                                                                                                        |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| A0   | Merge #1593 purpose pad refuse | **SHIPPED** — CI green (Tests re-run after unrelated svc-bank race flake); on `origin/main` as `1f9e4733` / `#1593`            |
| A1   | freeze/purpose residual        | **SEALED** #1559 · #1517 · #1481 · **#1593** (0012 JS-trim belt)                                                               |
| A1   | S2S body-bind residual         | **PARK** — ledger accepts `accept-both`/`require`; **svc-pay** still unbound. Flip would 401 pay money posts. L01 wall.        |
| A2   | recipe residual                | **SEALED** registry **50** ≡ RECIPES.md **50** (registry.test dual-check)                                                      |
| A2   | reconcile residual             | **SEALED** #1274 live `POST /operator/reconcile` three-check + freeze-on-fail + cron; admin simulated stub = edge/ops residual |
| A2   | sibling purpose residual       | **PARK** — other service walls                                                                                                 |
| A3   | treasury freeze policy         | **PARK Class X**                                                                                                               |
| A3   | Engine B pass                  | **this stop**                                                                                                                  |
| A3   | path-intersect pay             | **no dual packages thrash** — claim-check clear post-merge                                                                     |
| A3   | mint/burn asset keys           | **SEALED** #1522                                                                                                               |

## Engine B — promise falsification (tip)

| Claim                               | Reality                                                | Status                     |
| ----------------------------------- | ------------------------------------------------------ | -------------------------- |
| Purpose pads (space)                | 0011 belt                                              | **holds**                  |
| Purpose pads (tab/NBSP/CR/LF/VT/FF) | 0012 CHECK + client `.trim()` pins                     | **holds (#1593)**          |
| Freeze attribution refuse           | writeFreeze + operator 409                             | **holds**                  |
| Same freeze true no-op              | no UPDATE / no bus re-fire                             | **holds**                  |
| Env never thaws                     | applyStartupPolicy one-way                             | **holds**                  |
| Recipes named honest                | 50 pure; matrix ≡ registry                             | **holds**                  |
| Reconcile real not simulated        | operator HTTP + service.reconcile; no `simulated` flag | **holds (ledger half)**    |
| Mint/burn multi-asset keys          | assetId in keys                                        | **holds**                  |
| S2S body-bind require closed        | open while accept-both + pay unbound                   | **parked (not L06 craft)** |

**Proof this session (RAN-IT):**

- tip worktree at `origin/main` (base at stop authoring: `8972c3fa`; re-fetch before merge)
- `pnpm --filter @intafaced/ledger-client test` → **272/272**
- registry keys **50** ≡ RECIPES.md recipe rows **50**
- #1593 CI: Doctrine · Typecheck · Tests · Definition of Done green after bank flake re-run (bank suite uses **MemoryLedger** — not caused by 0012)

## Engine C — attack surface

| Surface                      | Note                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| second pot invent            | 0012 refuses tab/NBSP dual pots on raw SQL; client already trimmed |
| simulated reconcile          | ledger path has no `simulated` flag                                |
| S2S replay while accept-both | residual until pay v2 + operator flip — not invent on this wall    |
| invent treasury policy       | Class X — parked                                                   |

## Parked with pick-up (named owner wall)

1. **L01 pay:** `serviceAuthHeadersForBody` on pay ledger-client → quiet v1 → `INTERNAL_SERVICE_BODY_BIND=require`.
2. **Edge/ops:** proxy `POST /operator/reconcile` into admin; delete simulated stub.
3. **Pay:** chargeback recipe wire when card rail Done-bar requires it.
4. **§13:** history pagination `after` cursor; chain per-asset shard when volume forces.
5. **Class X:** treasury freeze _policy_ content — never invent.
6. **assets.decimals:** product fee/dust policy before wiring into posts.
7. **Trade:** MM maker fill settleFill wiring (recipe exists).

## Wall discipline

Exclusive paths only. Did not implement pay body-bind, did not flip require, did not invent §8 rates or treasury policy, did not dual-write sibling services. Did not re-cook W10 seals as new product.

## SAFE TO CLOSE

**yes** — open-PR bank cleared (#1593); exclusive-wall product craft residual-empty; parks named and owned elsewhere.
