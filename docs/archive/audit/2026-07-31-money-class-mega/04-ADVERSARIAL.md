# 04 — Adversarial critic · M226 P0/P1 queue

**Role:** fresh-context maker-checker Phase 4 (assume every finding may be wrong)  
**Worktree tip:** `4b77c173cd04c1d347da53cefaecb0c8fdd42c0c`  
**Sources re-read:** `03B-MONEY-226.md`, `03-FINDINGS.md`, plus cited rails / payment-service / user-money-service  
**UTC:** 2026-07-31  
**Scope of this file:** M226-01 … M226-04 only (not P2s, not PASS controls)

---

## Queue result (at a glance)

| id      | Critic call                       | Severity after critic                         | Fix owner this fire                           |
| ------- | --------------------------------- | --------------------------------------------- | --------------------------------------------- |
| M226-01 | **ACCEPT** (scope-split severity) | P0 multi-replica; **P1** single-process pilot | Denon/human (durable store + go-live hold)    |
| M226-02 | **ACCEPT**                        | **P1** (keep)                                 | Agent surface + Denon review; not silent-fix  |
| M226-03 | **DOWNGRADE-to-P2**               | P2                                            | Agent later; not this-fire P1 force           |
| M226-04 | **ACCEPT**                        | **P1** (keep; product-shaped)                 | Denon product call; agent only after decision |

---

## M226-01 · MemoryBroadcastStore double send

**Maker claim (P0):** Production live rail journals outbound broadcasts only in process-local `MemoryBroadcastStore`. Crash after `eth_sendRawTransaction` and before `put`, or a second replica, can broadcast the same business key twice — irreversible double payout/refund on chain.

### Verdict: **ACCEPT** (with severity split: not uniformly P0 for single-process pilot)

### Counter-argument (assume the finding is overstated)

The residual is **named by the code and README**, not a silent discovery: `broadcast-store.ts:1–18` and README:123 already state single-process-only and the crash-between-send-and-put window. Within one process, claim→send→put ordering is real: concurrent claimers converge on one hash (`broadcast-store.test.ts`), and put-before-receipt closes the inclusion-wait window (`evm-chain.ts:165–201`). Payout business keys on the withdrawal path are strong and stable (`pay.payout:${settlementId}` via `withdrawalId:attempt` — `crypto-native.ts:425–431`, `user-money-service.ts:416–417`), so _successful_ same-process retries after put are safe. Labeling this P0 as if production were already multi-replica misstates the shipped pilot posture: `tryLiveChainFromEnv` always injects `MemoryBroadcastStore` (`posture.ts:417`) _by design for v1_, and 03B’s own verdict already says “single-process pilot with eyes open.” Multi-replica double-claim is architectural non-support, not a regression from a durable store that was promised and then dropped. Calling every documented Class M residual “P0 ship-stop” collapses the difference between “do not scale out” and “money is wrong on the happy path.”

### What would change the critic’s mind

- Evidence that **two replicas of svc-pay with live rail already run in staging/prod** against one hot wallet (then pure P0, immediate hold).
- A measured path where **client retry after process death is automatic and frequent** on live withdraw (then pilot crash-window rises toward P0).
- Proof the window is closed (durable journal before broadcast, or chain-level account-nonce + recovery that returns the same hash without a second send).
- Evidence put is synchronous durability _somewhere_ outside the process map (it is not — re-read shows only `Map`).

### Fix this fire?

**Denon/human only.** Durable `BroadcastStore` needs a shared journal (schema + migration + HA semantics), go-live policy, and likely ops runbook. Not a surgical agent “swap the class” without a design. **Do not** treat “add a comment” or “assert single replica in env” as closing Class M.

### False-done risks if “fixed” poorly

- Journal that writes **after** send only (same race, prettier name).
- “Durable” store that is still **per-pod volume** or local SQLite with multi-replica.
- claim without **atomic** mine/done across workers (two mines).
- Closing multi-replica only and claiming M226-01 done while crash-window remains.
- Silencing README residual without a store that survives process death.

### Single-process pilot vs multi-replica — is P0 correct?

| Deployment                | Double-send mechanism                                                                                                                                                                                                        | Critic severity                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-replica go-live** | Each process owns its own `MemoryBroadcastStore`; concurrent payouts with same business key can both get `mine`                                                                                                              | **P0** — correctly ship-blocker; do not call multi-replica green                                                                                                                                                                                                                                                  |
| **Single-process pilot**  | Only if process dies (or memory reset) **after** chain accept of send and **before** `put`, then recovery **retries the same key** (withdraw explicitly re-asks rail on `held` — `user-money-service.ts:399–407`, `447–452`) | **P1 residual**, not automatic continuous failure. Window is real and irreversible when hit; probability is crash-in-ms-window, not every request. **Not** “only multi-replica” — pilot still has a Class M hole on the **documented recovery path** — but P0 overstates pilot urgency relative to multi-replica. |

**Answer to the explicit question:** M226-01 is **correctly P0 for multi-replica go-live**. For **single-process pilot** it is a **true residual that should stay open**, better graded **P1** (hold + eyes open), unless pilot ops treat process-restart-during-payout as routine — then escalate back to P0. Critic does **not** REJECT the finding; critic **refuses “must fix this fire before pilot”** as the implied action for single-process.

---

## M226-02 · Refund sequence key (not durable refundId)

**Maker claim (P1):** Refund on-chain idempotency key is `pay.refund:${ref}:${++this.refundSequence}` — process memory, not the payment core’s durable `refundId`. Recovery that re-calls `adapter.refund` after a first broadcast can mint a new key → second on-chain refund. Core in-flight gate blocks _new_ API refunds but does not make phase-2 rail retry safe.

### Verdict: **ACCEPT** (keep **P1**)

### Counter-argument (assume the finding is overstated)

Payment core **intentionally refuses** re-send while `refund.posted` lacks `refunded` / `refund.reversed` (`payment-service.ts:1300–1317`, comments `1262–1265`). The normal public refund API therefore does **not** re-enter `adapter.refund` after a crash mid-phase-2; it leaves an operator-reconcile state. That is the opposite of “restart automatically double-refunds.” The sequence counter exists partly for a _real_ product rule: two partial refunds of the same payment are two real sends, not one retried send (`crypto-native.ts:358–361`). Payout already proves the adapter _can_ use a stable business key when the interface carries one (`pay.payout:${settlementId}`). `RailAdapter.refund(ref, amount)` has no refundId by §6.1 (`rail-adapter.ts` / payment-service comment) — so the adapter cannot invent durable keys without a contract change; some of the “bug” is interface debt, not a coding slip in one line. Immediate same-process failure path decrements `refundSequence` on throw (`crypto-native.ts:387`), so a lone retry can reuse `:N` if nothing else advanced the counter — partial mitigation the finding underweights. Ledger `refund.posted` / reverse keys remain correct; chain is the weak leg only when someone bypasses the in-flight gate.

### What would change the critic’s mind

- A code path (admin job, reconcile script, or bug) that **re-calls `adapter.refund` on in-flight refunds** without a stable key (then upgrade urgency / keep hard P1).
- Proof that ambiguous RPC success (send lands, client sees throw) + ledger reverse + new refund attempt **systematically** double-pays under interleaved sequence use (then keep P1 with a concrete test case).
- Adapter keys already including durable `refundId` (then REJECT).
- Product decision that live refunds are off until interface lands (then residual HOLD, not fix-this-fire).

### Fix this fire?

**Not fully agent-safe alone.** Passing a stable key needs either: (a) extend `RailAdapter.refund` (+ conformance) — **Class M interface PR, Denon review**, or (b) a crypto-native-only convention if core can pass id another way without breaking §6.1. Agent may draft the interface + adapter key change; **must not** invent a recovery job that re-fires refunds. Prefer residual + design note over a half-wired key.

### False-done risks if “fixed” poorly

- Keying only `pay.refund:${ref}` → **partial refunds collide** (second partial becomes no-op or wrong amount).
- Keying amount into the key without refundId → same amount twice becomes one send incorrectly, or retries of true failures cannot distinguish.
- Changing adapter key but adding an **operator “retry rail”** that ignores in-flight semantics → worse than today.
- Claiming fixed because ledger key is durable while chain key still uses sequence.
- Process-local map of “already refunded refundIds” without durable journal → same restart hole as M226-01.

---

## M226-03 · Finalized before webhook 2xx

**Maker claim (P1):** `drainFinalized` adds address to `finalizedEmitted` **before** webhook delivery succeeds. Failed POST is only logged; that finalization never re-queues. Auto-capture via watcher can stall.

### Verdict: **DOWNGRADE-to-P2**

### Counter-argument (assume the finding is overstated)

This is **automation reliability**, not ledger/custody double-move. Maker already concedes manual authorize/capture still works if chain state remains visible (`inboundTransfer` / adapter authorize-capture read `observed`, not `finalizedEmitted`). `finalizedEmitted` is **in-memory only** (`evm-chain.ts:258–267`); a process restart clears it and the watcher will emit again — transient webhook failure that coincides with a later restart **self-heals**. Payment core webhook path is built for at-least-once delivery and dedupes on `rail_event_id` (`payment-service.ts:1427–1438`); marking after 2xx would _increase_ duplicate POSTs under retry, which the core already tolerates — so “mark before 2xx” is a classic at-most-once _watcher-side_ choice, not an unexamined footgun. Non-2xx only logs (`chain-watcher.ts:107–108`) — bad ops visibility if logs are ignored, but not silent money wrong. Elevating to P1 next to true Class M double-send findings inflates the queue and pulls agent effort off irreversible paths.

### What would change the critic’s mind

- Proof **manual capture is blocked** after a failed watcher delivery (e.g. observed cleared, or status machine requires webhook-only).
- Production depends on **auto-capture only** with no poll/authorize path and no restart (then P1 ops).
- Evidence funds become **unbookable** (not merely delayed) after one failed POST.
- `finalizedEmitted` persisted durably **before** 2xx (then true permanent drop — upgrade to P1).

### Fix this fire?

**Agent-safe later (surgical), not P1 this fire.** Mark-after-2xx or unmark on non-2xx is small; durable outbox is larger. Prefer residual unless auto-capture is on the pilot critical path.

### False-done risks if “fixed” poorly

- Mark after 2xx **without** retry loop → still drop on process death mid-deliver (symmetric hole).
- Infinite retry without backoff → hammer `/webhooks/crypto-native`.
- Removing dedupe and relying on mark-after-success only → double book if core marker fails open.
- “Fixed” by documenting manual capture only while PEACE still claims watcher auto-capture green.

---

## M226-04 · First-tx-wins dust

**Maker claim (P1):** First inbound tx to an acceptance address wins forever. Dust/underpay locks observation; later correct payment ignored → payment fails underpaid/pending while funds sit at the address.

### Verdict: **ACCEPT** (keep **P1** as product/griefing residual)

### Counter-argument (assume the finding is overstated)

First-tx-wins is **explicit, tested intent**, not an accidental branch: `record()` (`evm-chain.ts:278–291`) and live-test commentary (`evm-chain.live.test.ts:83–85`). Underpay fails **honestly** with failure code and raw funds location (`crypto-native.ts:224–237`) — not a silent credit of dust as full payment. Overpay is accepted as full delivery amount (`crypto-native.ts:240–250`); the failure mode is underpay/dust _first_, not stranger credit of random addresses (addresses are HD per payment, scan only watched — Q5 in 03B). Funds are not stolen by the greifer; they sit at a merchant-controlled acceptance address and remain in `raw` for support. Open-invoice dust front-running is an industry-known crypto UX issue; amount-matching or multi-transfer indexing is a **product** choice (replace vs top-up vs multi-input), not a one-line bugfix. For a closed pilot with non-public addresses and trusted payers, exploitability is lower than P1 suggests.

### What would change the critic’s mind

- Evidence production checkout **publishes** addresses widely and dust griefing is in scope for pilot (keep hard P1 / product gate).
- A path that **books dust as full capture** (then upgrade — that would be money-wrong; re-read does **not** show this).
- Address reuse across payments (then dust locks the wrong invoice) — HD per paymentId argues against.
- Product already chose amount-threshold replace and code still first-tx-wins (then pure bug ACCEPT).

### Fix this fire?

**Denon product first; agent only after decision.** Options (each has UX/money implications): prefer tx ≥ expected; sum multiple transfers; expire address and rotate; manual ops credit. Agent inventing amount-match without product call risks wrong double-count or stranding overpays. **Not** a silent surgical “fix” this fire.

### False-done risks if “fixed” poorly

- Always take **latest** tx → reorg/replace races and abandonment of earlier real pay.
- **Sum** all transfers without caps → attacker pads; or books more than intent without core rules.
- Replace observed without reconciling already-emitted webhook / capture.
- Claiming “dust immune” while first-tx-wins remains and only docs changed.

---

## Cross-cutting answers

### Is M226-01 correctly P0 for single-process pilot?

**No — not at the same P0 bar as multi-replica.**  
**Yes — as an open Class M residual that forbids multi-replica and forbids calling crash-safe outbound “done.”**  
Critic recommendation for PEACE language: **P0 hold on multi-replica go-live; P1 residual on single-process pilot crash-window; do not close either with a code comment.**

### Implied “must fix this fire” map

| id      | Must fix this fire?                                                                             |
| ------- | ----------------------------------------------------------------------------------------------- |
| M226-01 | **No** code fix required for pilot; **yes** hold multi-replica; durable store is Denon track    |
| M226-02 | **Prefer design residual** unless refunds go live on EVM this fire; interface change is Class M |
| M226-03 | **No** (downgraded P2)                                                                          |
| M226-04 | **No** agent fix without Denon product decision                                                 |

### Implementer instruction (Phase 5)

- Do **not** “fix” M226-01 with a fake store or env assert alone.
- Do **not** auto-implement M226-04 amount policy.
- M226-03 is optional polish, not P1 queue.
- M226-02: only with refundId on the wire into send keys + conformance; else leave residual explicit.

---

## Critic meta

- Re-read sources: `broadcast-store.ts`, `evm-chain.ts` (send/drain/record), `chain-watcher.ts`, `crypto-native.ts` (refund/payout/authorize underpay), `posture.ts:417`, `payment-service.ts` refund phases, `user-money-service.ts` withdraw phases, README:123, live test dust comment.
- No chain, no live money, no tests executed this critic turn — architecture/evidence only.
- PASS controls M226-09–12 and P2s M226-05–08,13 **not** re-criticized here.
