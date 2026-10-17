# 03-P2P-CONVERT — svc-p2p escrow + svc-trade convert

**Targets:** P2P escrow money path (`services/svc-p2p`) · one-tap convert (`services/svc-trade` convert + spot hold path)  
**Worktree:** `.worktrees/audit-denon-wave-deep`  
**Layer:** L1 Doctrine · L2 Auth · L3 Money · crash ordering  
**Mode:** read-only judgment · file:line evidence · backend only  
**UTC:** 2026-07-31  
**Out of scope:** frontend, vendor Stream A, live HTTP fleet probe

---

## VERDICT

**CONDITIONAL PASS on P2P escrow architecture; PASS on convert money path; one HIGH production-path hole on P2P insufficient-funds typing.**

P2P’s **decide-then-post** + **re-drive-don’t-interrogate** design is doctrine-correct: purpose-keyed escrow pots, business-key recipes only, no service-held balances, fail-closed auth at mount, money as bigint/decimal strings. Convert invents **no second money path** — RFQ is pure math; execute is market IOC through the same `orderHold` → fill path as spot, with fail-closed perks and scope.

| Surface                                      | Verdict                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Claim-before-post (P2P terminal)             | **PASS** — resolution committed before ledger post; settlement sweep re-drives                                        |
| Claim-before-post (convert / spot hold)      | **PASS** — intent row before hold; hold key `order.hold:<orderId>`                                                    |
| Ledger recipes only                          | **PASS** — `escrowLock` / `escrowRelease` / `escrowRefund` · convert → `orderHold` / `tradeFill` / `orderHoldRelease` |
| Auth fail-closed                             | **PASS** (edge principal + scopes; internal S2S gated; forged principal null)                                         |
| Money as JS `number`                         | **PASS** for amounts (bps / counters / ratios only as number)                                                         |
| Production HTTP → void on insufficient funds | **FAIL / HIGH** — typed error lost on wire (P2P-01)                                                                   |

**P0: 0 · P1: 1 (P2P-01) · P2/info: several**  
**Not go-live on P2P production insufficient-funds void path until P2P-01 fixed.** Convert can ship with residuals noted.

---

## Binding answers (the four questions)

| #   | Question               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Claim-before-post?** | **Yes on both.** P2P: `recordDecision` / `writeDecision` commits `resolution` + `resolved_at` **before** `settle()` posts (`p2p-service.ts:948–1076`); crash window is `resolved_at IS NOT NULL AND settled_at IS NULL`, healed by `sweepSettlements` (`:1264–1284`). Convert: `placeOrderInner` inserts `pending` order **before** `ledger.post(orderHold)` (`trade-service.ts:473–531`); convert execute only wraps that path (`:274–321`).                                                                             |
| 2   | **Ledger recipes?**    | **Yes.** P2P money posts only `recipes.escrowLock` / `escrowRelease` / `escrowRefund` (`p2p-service.ts:591–598,1044–1063`; recipes `packages/ledger-client/src/recipes/index.ts:256–301`). Pots are **per-trade** via `tradeEscrowAccount(..., tradeId)` purpose `trade:<id>` (`accounts.ts:51–52`) — L3-4. Convert posts **no convert-specific recipe**; hold/fill/release are the spot recipes. Fee on P2P release is **inside** `escrowRelease` (buyer + houseFees), not a second post.                                |
| 3   | **Auth fail-closed?**  | **Yes.** Mutating P2P: `scopedProcedure('p2p:write'\|'admin:compliance', { module: 'p2p' })`; actors bound to `ctx.principal.userId` (router). Mount: unsigned/forged principal → null → UNAUTHORIZED before service call (`router.mount.test.ts:79–110`; `index.ts` `createEdgeContext`). Internal integrity/reputation: `verifyServiceHeaders` → 401 (`index.ts:81–96`). Convert: `trade:read` quote / `trade:write` execute + service `requireScope`; placeOrder also fails closed on rank-perks S2S (prior 03-TRADE). |
| 4   | **Money as number?**   | **No for currency amounts.** Wire: decimal strings (`amountString` / `decimal` zod). Memory: `Amount` bigint via `parseAmount`/`formatAmount`. `feeBps` / `convertSpreadBps` / reputation counters use `number` as **rates or counts**, not balances. Fiat leg is also `Amount` + quantum quantise (`pricing.ts`).                                                                                                                                                                                                        |

---

## Surface map

### svc-p2p escrow

| Surface            | Role                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `p2p-service.ts`   | take → reserve → lock → advance; release/refund/dispute; sweeps    |
| `state.ts`         | pure machine; timeout total; escrow-holding set excludes `created` |
| `pricing.ts`       | bounds before lock; float refuses missing mark                     |
| `ledger-client.ts` | S2S post/balance; body-bound auth headers                          |
| `router.ts`        | scopes, party checks, decimal I/O                                  |
| `index.ts`         | edge context, internal auth, dual sweeps before listen             |
| `recipes` escrow\* | purpose-keyed pots + business idempotency keys                     |

### svc-trade convert

| Surface                                                                    | Role                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `convert/quote.ts`                                                         | pure ladder walk + house spread (bigint only)                   |
| `trade-service.ts` `convertQuote` / `convertExecute` / `buildConvertQuote` | RFQ + re-quote + market IOC                                     |
| `router.ts` `convert.*`                                                    | scopes + decimal wire                                           |
| `spot/trade-service.ts` `placeOrderInner`                                  | real money path (hold → engine → fill)                          |
| tests                                                                      | `convert/quote.test.ts` · `trade-service.test.ts` convert block |

---

## Findings table

| id         | severity         | file:line                                                               | claim                                                                                                                                  | evidence                                                                                                                                                                                                                                                                                                                                                                                    | fix-owner                                                                                                                                                                                                                                            |
| ---------- | ---------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P2P-01** | **HIGH**         | `svc-p2p/src/ledger-client.ts:57–63` · `p2p-service.ts:600–614,760–768` | Production HTTP client never rehydrates `InsufficientFundsError`; void-on-failed-lock only runs on `instanceof InsufficientFundsError` | HTTP path: `throw new Error(\`svc-ledger …: ${detail}\`)`. Service: only `err instanceof InsufficientFundsError`voids + restores inventory. Tests use`MemoryLedger`(typed) so suite is green while fleet path leaves trades in`created`with inventory reserved when lock fails on funds; timeout sweep rethrows same untyped error and marks`failed` without void (`applyTimeout`/`unwind`) | Map ledger 400 / message / code → `InsufficientFundsError` (or message/code branch) in HTTP client; add contract test with mock HTTP body; optionally void on any definitive non-retryable lock failure after idempotent re-drive returns funds-fail |
| P2P-02     | **PASS**         | `p2p-service.ts:57–75,948–1076,1256–1284`                               | Decide then post; late not stranded                                                                                                    | Resolution before post; `sweepSettlements` re-posts idempotent keys                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                    |
| P2P-03     | **PASS**         | `recipes/index.ts:256–301` · `accounts.ts:51–52`                        | Purpose-keyed escrow; no cross-trade refund theft                                                                                      | `tradeEscrowAccount(seller, asset, tradeId)`; release/refund credit that pot only; tests assert no refund of B from A’s pot                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                    |
| P2P-04     | **PASS**         | `p2p-service.ts:526–528,591–598` · `pricing.ts:145–170`                 | Bounds / method / self-trade before lock                                                                                               | Reserve under offer row lock; lock only after commit of `created`                                                                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                                    |
| P2P-05     | **PASS**         | `state.ts:205–223` · `p2p-service.ts:1213–1226`                         | `fiat_sent` timeout opens dispute, never auto-release                                                                                  | `timeoutActionFor('fiat_sent') === 'open_dispute'`                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                    |
| P2P-06     | **PASS**         | `router.ts:15–19,148–361` · `index.ts:67–96` · mount tests              | Auth fail-closed; party-bound mutates; dispute resolve `admin:compliance`                                                              | scopedProcedure + principal userId; get trade not-found for non-party                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                                                    |
| P2P-07     | **PASS**         | `router.ts:22–23,395–433` · `pricing.ts:12–15`                          | Money not JS number                                                                                                                    | amountString regex; parse/format Amount                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                    |
| P2P-08     | **PASS**         | `ledger-client.ts:40–54` (p2p)                                          | Body-bound S2S auth on ledger posts                                                                                                    | `serviceAuthHeadersForBody` + single serialize                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                    |
| P2P-09     | **P2**           | `p2p-service.ts:468–542` · `router.ts:212–231`                          | Service accepts `feeBps` override; **router does not expose it**                                                                       | Production fee = `env.P2P_FEE_BPS` only via index wiring. Residual: any future caller of `takeOffer({ feeBps: 0 })` can zero fee                                                                                                                                                                                                                                                            | Keep fee off public input forever; optionally delete service override or force env-only                                                                                                                                                              |
| P2P-10     | **P2**           | `p2p-service.test.ts:52–54`                                             | Entire Postgres money suite skippable if DB down                                                                                       | `describe.skip` when probe fails — same class as bank B-04                                                                                                                                                                                                                                                                                                                                  | CI must require dedicated P2P test DB                                                                                                                                                                                                                |
| P2P-11     | **info**         | README + `index.ts:59–61`                                               | Floating offers refused without reference price                                                                                        | Fail-closed pricing, not stale invent                                                                                                                                                                                                                                                                                                                                                       | supply mark from trade when ready                                                                                                                                                                                                                    |
| **CVT-01** | **PASS**         | `convert/quote.ts` · `trade-service.ts:255–366`                         | Convert math pure; execute = spot path                                                                                                 | `estimateConvert` bigint; execute → `placeOrder` market IOC `convert:<clientConvertId>`                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                    |
| **CVT-02** | **PASS**         | `trade-service.ts:310–321,473–531`                                      | No second money path; intent before hold; idempotent convert id                                                                        | Same orderHold key; test asserts one hold on double-tap                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                    |
| **CVT-03** | **PASS**         | `router.ts:322–380` · `trade-service.ts:264–286,468–471`                | Auth + perks fail-closed before hold                                                                                                   | scoped + requireScope; perks before INSERT                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                    |
| **CVT-04** | **PASS**         | `convert/quote.ts:12–13,118–140`                                        | Wire money decimal strings; bps int                                                                                                    | `presentConvertQuote` formatAmount                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                    |
| CVT-05     | **P2 / product** | `quote.ts:98–99` · `trade-service.ts:310–321`                           | Convert “house spread” worsens RFQ / maxAvg gate; **does not post a convert fee**                                                      | Execution is book market IOC; house revenue is normal trade fees on fill, not `convertSpreadBps`                                                                                                                                                                                                                                                                                            | Document as RFQ cushion not fee; or add explicit convert fee recipe if product wants edge capture                                                                                                                                                    |
| CVT-06     | **info**         | `trade-service.ts:318–320,451–460`                                      | Without `maxAvgPrice`, buy protection = slippage cap, not convert quote                                                                | Client should bind quote.avgPrice as maxAvgPrice for one-tap honesty                                                                                                                                                                                                                                                                                                                        | FE / API guidance                                                                                                                                                                                                                                    |
| CVT-07     | **PASS**         | `trade-service.ts:330–335` · tests                                      | Kill-switches refuse quote/execute                                                                                                     | convert + spot disabled codes                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                                    |

---

## Money path review

### P2P take → escrow → release / refund

| Phase     | Order                                                                          | Crash / retry                                                              |
| --------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| A Reserve | Bounds + price under offer `FOR UPDATE`; insert `created`; decrement remaining | Crash before lock: nothing locked; 2m deadline → re-drive then void/refund |
| B Lock    | `recipes.escrowLock` key `p2p.escrow.lock:<tradeId>`                           | Re-drive answers “did it post?”                                            |
| C Advance | status `escrowed`                                                              | After lock before advance: re-drive lock then refund path safe             |
| Terminal  | `writeDecision` then `settle` post then `settled_at`                           | Sweep settlements re-post; keys prevent double pay                         |
| Void      | Only when lock **definitively** never posted                                   | **Broken on HTTP client (P2P-01)** — MemoryLedger tests still pass         |

### Convert

| Phase   | Order                                                   |
| ------- | ------------------------------------------------------- |
| Quote   | Depth → `estimateConvert` + spread; no ledger           |
| Execute | Re-quote → optional maxAvg → `placeOrder` market IOC    |
| Hold    | Intent row → `orderHold` → engine → fill/cancel release |

Ordering guarantee matches spot (documented in trade-service header): no hold without row; no engine without hold; cancel engine before release.

---

## Auth matrix (complete for these surfaces)

| Procedure / route                             | Guard                | Party bind                               |
| --------------------------------------------- | -------------------- | ---------------------------------------- |
| `offers.*` mutate                             | `p2p:write` + module | maker = principal                        |
| `trades.take`                                 | `p2p:write`          | taker = principal                        |
| `markFiatSent` / `confirmReceived` / `cancel` | `p2p:write`          | buyer / seller / party checks in service |
| `trades.get`                                  | `p2p:read`           | party-only else NOT_FOUND                |
| `disputes.resolve`                            | `admin:compliance`   | moderator = principal                    |
| `/internal/*`                                 | service headers      | no user principal                        |
| `convert.quote`                               | `trade:read`         | principal only for scope                 |
| `convert.execute`                             | `trade:write`        | order userId = principal                 |

---

## What was **not** verified

- Live multi-service HTTP (p2p → ledger) end-to-end on this host
- Postgres suite execution this turn (may skip without Docker)
- Concurrent release race under production ledger latency
- Moderator backstop config correctness in deploy env
- FE binding of convert `maxAvgPrice` to quote

---

## Residual queue

| id         | severity | status                                                                                                                 |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| **P2P-01** | **HIGH** | Open — rehydrate insufficient-funds on HTTP ledger client (blocks confident go-live of P2P take under real svc-ledger) |
| P2P-09     | P2       | feeBps service override not on router — keep closed                                                                    |
| P2P-10     | P2       | suite skip without DB                                                                                                  |
| CVT-05     | P2       | convert spread is RFQ cushion not fee leg                                                                              |
| CVT-06     | info     | maxAvgPrice optional                                                                                                   |

**P0: 0 · P1: 1 · PASS rows: 14 · residual notes: 4**

---

## Closing

P2P escrow is among the strongest money designs in the monorepo (purpose pots, decide-then-post, timeout totality, no auto-release on fiat_sent). The one hole that matters is **type erasure on the production ledger client**, which disables the exact branch that prevents reserved inventory limbo when the seller cannot fund the lock — tests cannot see it because they inject `MemoryLedger`.

Convert is a thin RFQ shell over spot holds: correct for doctrine (no parallel money path), fail-closed auth, bigint math. Ship convert with product clarity on spread; **do not** treat P2P as production-safe for insufficient-funds void until P2P-01 lands.

**Next verify:** unit test that HTTP-shaped error body from svc-ledger post failure still voids a `created` take and restores offer remaining.
