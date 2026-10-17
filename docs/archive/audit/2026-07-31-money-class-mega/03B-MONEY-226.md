# 03B — L3 Money + L10 Migration · PR #226 live EVM rail (+ #244 sell cost)

**Tip:** `4b77c173cd04c1d347da53cefaecb0c8fdd42c0c`  
**Scope:** `services/svc-pay/src/rails/**` + mount (`index.ts`/`env.ts`) + e2e script; light #244 cost honesty  
**Mode:** read-only code audit · no chain · no secrets · no install  
**UTC:** 2026-07-31

---

## Q&A (required eight)

### 1. Can the live rail credit/debit/move **ledger** value outside `packages/ledger-client`?

**No.** The rail layer never posts ledger entries.

| Surface         | Evidence                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| Chain watcher   | `chain-watcher.ts:8–12` — "Nothing here moves ledger money." POSTs signed webhook only.                       |
| Rail mount      | `index.ts:45–47` — "Value moves through svc-ledger… This client is the only path." `createLedgerClient` only. |
| Capture         | `payment-service.ts:1212–1220` — `this.ledger.post(recipes.paymentCapture(...))`.                             |
| Refund / payout | `payment-service.ts:1333–1343`, `1803+`; `user-money-service.ts:384`, `453` — recipes via ledger client.      |
| Wire amounts    | `ledger-client.ts:59–72` — `formatAmount` decimal strings on `/trpc/post`.                                    |

On-chain native/ERC-20 transfers (`evm-chain.ts:164–201`) move **custody**, not ledger balances. Booking is always a separate recipe with a business idempotency key.

### 2. Is money ever stored as `number` (float) on wire/DB for amounts?

**No for money amounts.** Scaled `bigint` (`Amount`) in process; decimal strings on wire; `numeric(38,18)` in DB.

| Surface               | Evidence                                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| Rail contract         | `rail-adapter.ts:88–89` — amount is scaled bigint.                               |
| Chain units           | `evm-assets.ts:7–9`, `74–98` — conversion only at boundary; refuse truncation.   |
| Webhook body          | `chain-watcher.ts:86` — `formatAmount(transfer.amount)` string.                  |
| JSON number rejection | `crypto-native.ts:489–492` — non-string amount → null (reject).                  |
| DB column             | `packages/db/src/columns.ts:29` — `numeric(name, { precision: 38, scale: 18 })`. |
| Payment row update    | `payment-service.ts:1107` — `formatAmount(result.amount)::numeric`.              |

Non-money `number` uses (chainId, confirmations, poll interval, bps) are integers, not balances.

### 3. Claim-before-post / double-submit / idempotency keys?

| Path             | Ordering                                                                                                                         | Keys                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Outbound send    | **claim → eth_sendRawTransaction → put hash → wait receipt** (`evm-chain.ts:164–201`, `broadcast-store.ts:9–14`)                 | `ChainSendRequest.idempotencyKey`             |
| Payout           | adapter → `pay.payout:${settlementId}` (`crypto-native.ts:425–431`)                                                              | settlement id                                 |
| Refund (adapter) | **process-local** `pay.refund:${ref}:${++refundSequence}` (`crypto-native.ts:362`)                                               | **not** payment `refundId` — residual M226-02 |
| Capture          | rail first, ledger second; status gate + `payment.capture:<paymentId>` (`payment-service.ts:47–52`, `1144–1147`, `1212–1220`)    | payment id                                    |
| Refund (core)    | ledger first (`refund.posted`), rail second, reverse on rail fail; in-flight blocks (`payment-service.ts:54–58`, `1300–1351`)    | `refundId` on ledger                          |
| Webhook          | effect **before** dedupe marker on purpose (`payment-service.ts:1437–1441`, `1529–1548`); unique `rail_event_id`                 | `${adapter.id}:${event.eventId}`              |
| Concurrent claim | `MemoryBroadcastStore.claim` — one `mine`, others wait for put (`broadcast-store.ts:51–66`, test `broadcast-store.test.ts:5–24`) |                                               |

### 4. Does posture fail-closed when live keys/RPC missing (sandbox vs live)?

**Yes for staging/prod.**

| Gate                      | Evidence                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| No RPC in enforced env    | `posture.ts:348–354` — `UnconfiguredChain` (refuses every call).                                                                  |
| Partial live config       | `posture.ts:375–398` — RPC set but missing chainId/mnemonic/hotKey/assets → **throw** (no quiet MemoryChain).                     |
| Boot sandbox refusal      | `posture.ts:160–170` — staging/prod + sandbox rail → `SandboxRailError` unless `PAY_ALLOW_SANDBOX_RAILS=true`.                    |
| Runtime payout/refund     | `assertRailMayMoveValue` before ledger (`posture.ts:215–219`; call sites `payment-service.ts:1326`, `user-money-service.ts:332`). |
| Public checkout           | Override does **not** relax public path (`posture.ts:173–182`, `270–273`).                                                        |
| Card sandbox registration | Off by default in staging/prod (`posture.ts:368–372`; `index.ts:72–79`).                                                          |
| Tests                     | `posture.test.ts:152–154`, `283–287`, `318–325`, `420–433`.                                                                       |

### 5. Can a stranger's tx get credited? Watcher confirmation depth?

**Only funds sent to a watched, payment-bound acceptance address after depth + asset/amount checks.**

| Control                               | Evidence                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Address = HD per (paymentId, assetId) | `evm-chain.ts:32–35`, `135–152`; stable index `361–364`.                                                                     |
| Scan only watched addresses           | `evm-chain.ts:217–231`, `325–328`.                                                                                           |
| Asset must match payment              | `crypto-native.ts:193–207`; ERC-20 entry must match asset (`evm-chain.ts:327–328`).                                          |
| Underpay fails (no capture credit)    | `crypto-native.ts:224–237`.                                                                                                  |
| Confirmations                         | Default 6 (`env.ts:33`, `posture.ts:409–418`, `crypto-native.ts:104`); capture re-checks depth (`crypto-native.ts:284–292`). |
| Watcher finality                      | `drainFinalized` only if `confirmations >= minConfirmations` (`evm-chain.ts:258–261`).                                       |
| Webhook auth                          | HMAC + timestamp tolerance (`crypto-native.ts:455–464`; secret min 32, no default — `env.ts:22`).                            |
| Unmatched ref                         | No payment invented (`payment-service.ts:1466–1475` → `pay.webhook_unmatched`).                                              |

A stranger paying **your** invoice address is intended (open payment). Dust-first poisoning of first-tx-wins is residual **M226-04**.

### 6. Broadcast store replay / double credit?

| Concern                          | Verdict                                                    | Evidence                                                         |
| -------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Replay same key after put        | Safe — returns original hash                               | `broadcast-store.ts:54–56`, `69–77`; `evm-chain.ts:168–169`      |
| Concurrent claimers              | One mine                                                   | `broadcast-store.test.ts:5–24`                                   |
| Inbound double book              | Status machine + ledger key + webhook dedupe               | `payment-service.ts:1056–1058`, `1156`, `1483–1490`, `1212–1220` |
| **Crash after send, before put** | **Double-send risk** (memory lost / PENDING not durable)   | `broadcast-store.ts:1–17`; README:123                            |
| **Multi-replica**                | **Not safe** — each process has own `MemoryBroadcastStore` | `posture.ts:417`; README:123                                     |
| Watcher re-delivery              | Same event id `chain:${txHash}:${address}` → duplicate     | `chain-watcher.ts:83`; payment_events unique                     |

### 7. Any migration in this delta for pay?

**None new for #226.** Existing only:

- `services/svc-pay/drizzle/0000_pay_init.sql`
- `0001_pay_user_money.sql`
- `0002_pay_payment_links.sql`
- `0003_pay_checkout_sessions.sql`

No `0004_*`. No durable `broadcast_journal` table. L10: live rail adds **no** schema migration; Class M outbound safety remains in-process memory only.

### 8. False-done: weak tests, empty catches, type suppressions?

| Item                                                        | Verdict                                                                                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ts-ignore` / `@ts-expect-error` / `as any` in `rails/**`  | **None** found.                                                                                                                                                             |
| Live suite skip without node                                | Honest skip; `REQUIRE_PAY_EVM=1` fails closed (`evm-chain.live.test.ts:44–48`).                                                                                             |
| `minConfirmations: 1` in live tests                         | Test-only; production default 6. Not a production false-done.                                                                                                               |
| `if (!first.ok) return` after `expect(first.ok).toBe(true)` | Dead narrow after hard assert — not a soft pass.                                                                                                                            |
| Watcher tick `catch`                                        | Logs and returns 0 (`chain-watcher.ts:67–71`) — ops visibility only; authorize path still polls chain.                                                                      |
| Conformance amount-as-number                                | Explicitly rejects JSON number money (`conformance.ts:563–570`).                                                                                                            |
| #244 cost                                                   | `presentCcxtOrderCost` returns `null` (not `"0"`) for filled market sell without fill load (`private-rest.ts:166–179`); `orderSchema.cost` nullable (`schemas.ts:214–219`). |

---

## Findings

### M226-01 | P0 | `services/svc-pay/src/rails/posture.ts:417` · `broadcast-store.ts:1–17` · `evm-chain.ts:164–201`

**Claim:** Production live rail journals outbound broadcasts only in process-local `MemoryBroadcastStore`. A crash after `eth_sendRawTransaction` and before `put`, or a second replica, can broadcast the same business key twice — irreversible double payout/refund on chain.

**Evidence:** `tryLiveChainFromEnv` always `broadcasts: new MemoryBroadcastStore()`. Store docs: "Production multi-replica MUST supply a durable store". Claim→send→put order leaves a window where the chain has the tx but the journal does not. README:123 names the residual.

**Fix-owner:** Denon (durable store impl) + human (multi-replica go-live hold until shared journal).

---

### M226-02 | P1 | `services/svc-pay/src/rails/crypto-native.ts:358–372`

**Claim:** Refund on-chain idempotency key is `pay.refund:${ref}:${++this.refundSequence}` — process memory, not the payment core's durable `refundId`. After process restart (or any recovery that re-calls `adapter.refund` once the first broadcast already left), a **new** key is generated → second on-chain refund even when ledger `refund.posted` already exists. Core in-flight gate (`payment-service.ts:1300–1317`) blocks _new_ API refunds but does not make phase-2 rail retry safe.

**Evidence:** Sequence counter + `refunded` Map are instance fields (`crypto-native.ts:96–97`). Interface `refund(ref, amount)` carries no refundId. Ledger key is correct; chain key is not aligned.

**Fix-owner:** agent (pass stable refundId into send key; may need RailAdapter surface PR) / Denon review.

---

### M226-03 | P1 | `services/svc-pay/src/rails/evm-chain.ts:258–267` · `chain-watcher.ts:62–64`

**Claim:** `drainFinalized` adds address to `finalizedEmitted` **before** webhook delivery succeeds. A failed/rejected POST (`chain-watcher.ts:107–108` only logs) never re-queues that finalization. Auto-capture via watcher can stall; manual authorize/capture still works if chain state remains visible.

**Evidence:** emit mark at `finalizedEmitted.add` then return; deliver has no success-gated unmark.

**Fix-owner:** agent — mark emitted only after 2xx, or durable outbox.

---

### M226-04 | P1 | `services/svc-pay/src/rails/evm-chain.ts:278–291`

**Claim:** First inbound tx to an acceptance address wins forever (`if (prev && prev.txHash !== next.txHash) return`). Dust or underpayment locks the address observation; a later correct payment is ignored → payment fails underpaid/pending while funds sit at the address.

**Evidence:** `record()` first-tx-wins; live test comment at `evm-chain.live.test.ts:83–85` acknowledges the mode. Adapter underpay path fails honestly (`crypto-native.ts:224–237`) but does not unlock a second observation.

**Fix-owner:** Denon product + agent (amount-matching selection or multi-transfer index).

---

### M226-05 | P2 | `services/svc-pay/src/rails/evm-chain.ts:294–300`

**Claim:** ERC-20 log scan uses a sliding window `max(minConfirmations*4, 64)` from tip. After restart, deposits older than the window can be missed until a deeper rescan is forced (`resetScan` is test-only).

**Evidence:** `scanErc20` `fromBlock`/`toBlock` window; native path uses 2000-block lookback on first start (`evm-chain.ts:211–214`) — ERC-20 is tighter.

**Fix-owner:** agent (align lookback / durable scan cursor).

---

### M226-06 | P2 | `services/svc-pay/src/rails/evm-chain.ts:97–100`

**Claim:** Address book (`byPayment`/`byAddress`) and `observed` map are in-memory. HD re-derivation recovers addresses after restart; observed confirmations require re-scan. Single-instance OK with lookback; multi-replica address-book races unsolved.

**Evidence:** Maps in constructor state only; no DB.

**Fix-owner:** HOLD/human for multi-instance; agent if durable address book required for HA.

---

### M226-07 | P2 | `services/svc-pay/src/rails/posture.ts:221–228` · `rail-adapter` VALUE_LEAVING asymmetry

**Claim:** Under `live-only`, sandbox **authorize/capture** still allowed on merchant integration path (`assertRailMayMoveValue` skips non-value-leaving caps). Public checkout is closed. Residual risk only if operator registers sandbox card rail with override and merchants use it for real goods — platform short, reconciliation catch.

**Evidence:** `posture.test.ts:221–228`, `382–390`; public gate separate.

**Fix-owner:** human ops — do not enable sandbox acquirer for real merchants without override awareness.

---

### M226-08 | P2 | `services/svc-pay/src/rails/evm-chain.live.test.ts:44–48`, `63`

**Claim:** Live tests skip when anvil absent; default CI without node does not prove live rail. `REQUIRE_PAY_EVM=1` is the hard gate. Not a green-lie, but production confidence needs compose/paid CI.

**Evidence:** `describeLive = reachable ? describe : describe.skip`.

**Fix-owner:** human/CI — keep REQUIRE_PAY_EVM on paid path; residual if only skip path runs.

---

### M226-09 | PASS (control) | L10 migrations

**Claim:** #226 introduced no pay SQL migration; no broadcast durability schema. Confirmed expected absence.

**Evidence:** `services/svc-pay/drizzle/` stops at `0003_pay_checkout_sessions.sql`.

**Fix-owner:** n/a (absence is finding for go-live, not a code bug by itself — pairs with M226-01).

---

### M226-10 | PASS (control) | Ledger isolation + amount types

**Claim:** Live rail path does not hold balances or post outside ledger-client; amounts are bigint/decimal throughout rails + payment core.

**Evidence:** Q1–Q2 tables above.

**Fix-owner:** n/a.

---

### M226-11 | PASS (control) | Posture fail-closed + public checkout

**Claim:** Missing live config does not silently simulate in staging/prod; public checkout ignores sandbox override.

**Evidence:** Q4 table.

**Fix-owner:** n/a.

---

### M226-12 | PASS (control) | #244 sell cost honesty (related primary)

**Claim:** Market-sell order `cost` is honest-null without fills; exchange-contract allows `cost: decimal.nullable()`.

**Evidence:** `private-rest.ts:166–179`; `schemas.ts:214–219`. Order `fee: null` on list still residual product shape (not invented zero).

**Fix-owner:** n/a for this batch (prior residual if bots need fee on order object).

---

### M226-13 | P2 | `services/svc-pay/src/rails/crypto-native.ts:362` vs payout key quality

**Claim:** Payout keys on settlement id are strong; refund keys are not (see M226-02). No separate finding beyond that split.

**Evidence:** `pay.payout:${s.settlementId}` vs refund sequence.

**Fix-owner:** covered by M226-02.

---

## What could NOT be verified

| Item                                                           | Why                                          |
| -------------------------------------------------------------- | -------------------------------------------- |
| Real public RPC / mainnet reorg depth                          | No chain, no secrets in this session.        |
| Anvil e2e `live-rail-e2e.mjs` green                            | Not executed (read-only; no services).       |
| Multi-replica race in practice                                 | Architecture only.                           |
| Hot-wallet custody / mnemonic protection                       | Ops/secrets — HOLD.                          |
| Ledger recipe balance sheet under concurrent capture           | Trust package tests + keys; not re-run here. |
| CI Actions live EVM job                                        | Not queried this turn.                       |
| Hot wallet balance / underfunded payout failure modes on chain | Needs live node.                             |

---

## Finding count

| Severity                | Count  | IDs                                         |
| ----------------------- | ------ | ------------------------------------------- |
| P0                      | 1      | M226-01                                     |
| P1                      | 3      | M226-02, M226-03, M226-04                   |
| P2                      | 5      | M226-05, M226-06, M226-07, M226-08, M226-13 |
| PASS controls           | 4      | M226-09–12                                  |
| **Actionable (P0–P2)**  | **9**  |                                             |
| **Total findings rows** | **13** |                                             |

---

## VERDICT

**PASS-WITH-RESIDUALS.** Ledger doctrine holds: the live EVM rail does not credit/debit outside `ledger-client`, amounts stay scaled-bigint/decimal, posture fails closed in staging/prod without full live config, public checkout does not inherit sandbox override, webhooks require signature and match existing payments, and capture/payout paths use business-keyed ledger recipes. **What Denon would flinch at:** outbound Class M still sits on `MemoryBroadcastStore` (M226-01) — the same residual README and prior WAVE held open — so multi-replica or crash-between-send-and-put can double-spend on-chain; refund chain keys are process-local (M226-02); first-tx-wins dust can trap deposits (M226-04); watcher finality is fire-and-forget (M226-03). Ship posture for single-process pilot with eyes open; **do not** call multi-replica go-live green until durable broadcast journal + refund key alignment land. No new pay migration in #226 (expected). #244 cost honesty holds for market sells.
