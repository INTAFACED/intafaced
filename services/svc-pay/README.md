# svc-pay

The payments core (§6.1). Merchants, the payment lifecycle, settlement into the ledger, and the `RailAdapter` interface every external rail sits behind.

**What it is NOT:** it does not hold balances (the ledger does), it does not choose between rails (smart routing is its own feature), and it does not know the name of a single payment processor. Every rail — the two here and every one that comes later — is an implementation of one interface, and `src/rails/conformance.ts` is what keeps that true.

**On tip today:** gateway mode, rails (`crypto-native`, `card-sandbox`, absent `bank-payout`), public REST + webhooks, PayFac **sub-merchant trees + area fence on money paths** ([below](#payfac--sub-merchant-trees-61)), subscriptions as **crypto invoice-and-watch product-complete** (mandate � due � invoice � capture settle � cancel immediate; card path refuses `pay.mandate_rail_absent`; bounded dunning � `arrears` stall; pre-charge notify sealed as �13 `socket.pay-precharge-notify` with Ready `subscription.productReady`  never invents `notified:true`), destination shape refuse (EVM + IBAN) before hold, G3 settlement release, G4 suspend-safe payout hold, **PSP digital KYB** (`kyb.submit` / `kyb.decide` under `admin:compliance` + append-only KYB/pricing histories; no third-party money lib  D-S-10).
**On tip for pay.fraud (D26-P1-P5):** scoring + review queue + dispute **case** mechanism (`fraud.*` tRPC); chargeback ledger recipes refuse-closed via named �13 `socket.pay-chargeback-ledger-wire` (recipes exist in ledger-client  not posted from svc-pay). List content Class X.
**Still separate / residual:** smart routing (no invent costs/approval rates), commerce plugins, live card charge-against-mandate + real pre-charge delivery (`socket.psp-partners` / `socket.pay-precharge-notify`), IFSC bank dest without partner table, `pay:*` grant path (Nitro DIRECTION �8.4), `kybStatus` money-gate (pay.gateway  sequenced after approver), card acquiring (`socket.psp-partners`), durable disputes table + owner sign-off to close the chargeback ledger socket.

---

## The lifecycle

```
created ──authorize──▶ authorized ──capture──▶ captured ──settle──▶ settled
   │                        │                      │                   │
   └──────▶ failed ◀────────┘                      └──refund──▶ refunded ◀──refund──┘
```

`payment_events` is the append-only state history. Every transition appends a row; **nothing is ever overwritten**, and the database enforces that with a trigger rather than trusting the application. `payments.status` is a projection of that log, and the captured and refunded totals are summed from it — there is deliberately no `captured_amount` column, because a running total beside an event log is a second source of truth for money.

Where value actually is, at each stage:

| Stage        | Where the money is                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `created`    | Nowhere. Nothing has moved.                                                                                  |
| `authorized` | Nowhere in the book. A promise (card) or a confirmed on-chain transfer at an address we control (crypto).    |
| `captured`   | `pay:clearing:<merchantId>` in the ledger. Ours to hold, the merchant's to receive, not yet theirs to spend. |
| `settled`    | The merchant's own `available` balance, minus the fee.                                                       |
| `refunded`   | Back out through the rail boundary it came in on.                                                            |

---

## API

Internal tRPC (`src/router.ts`). Money is a **decimal string** in both directions; the input schema rejects a JSON number.

| Procedure                                           | Scope                                      | Input                                                                                 | Output                                           |
| --------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `health`                                            | public                                     | –                                                                                     | `{ ok, service, rails }`                         |
| `railHealth`                                        | `pay:read`                                 | –                                                                                     | `RailHealth[]`                                   |
| `merchant.create`                                   | `pay:write`                                | `{ mode, pricing: { feeBps } }` — `userId` from the principal, never the body         | `{ id, userId, mode, feeBps }`                   |
| `merchant.profile`                                  | `pay:write`                                | `{ merchantId, checkoutConfig, feeRouting, domains }`                                 | `{ id, merchantId }`                             |
| `merchant.balances`                                 | `pay:read`                                 | `{ merchantId, assetId }`                                                             | `{ clearing, available }` — read from the ledger |
| `payment.create`                                    | `pay:write`                                | `{ merchantId, amount, assetId, method, railAdapter, instrument? }`                   | `Payment`                                        |
| `payment.authorize`                                 | `pay:write`                                | `{ paymentId }`                                                                       | `Payment`                                        |
| `payment.capture`                                   | `pay:write`                                | `{ paymentId, amount? }`                                                              | `Payment`                                        |
| `payment.refund`                                    | `pay:refund`                               | `{ paymentId, amount, refundId }` (required)                                          | `Payment`                                        |
| `payment.get`                                       | `pay:read`                                 | `{ paymentId }`                                                                       | `Payment`                                        |
| `payment.history`                                   | `pay:read`                                 | `{ paymentId }`                                                                       | `PaymentEvent[]`                                 |
| `settlement.run`                                    | `pay:write`                                | `{ merchantId, window, assetId }`                                                     | `Settlement`                                     |
| `settlement.payout`                                 | `pay:payout`                               | `{ settlementId, railId, destination }` — dest must match rail (EVM/IBAN)             | `Settlement`                                     |
| `settlement.get`                                    | `pay:read`                                 | `{ settlementId }`                                                                    | `Settlement`                                     |
| `settlement.release`                                | `pay:write`                                | `{ settlementId, reason }` — unstick pending freeze; **no ledger move**               | `Settlement`                                     |
| `merchantState.set` / `accountControls.change`      | interactive MFA + live founder entitlement | `{ requestId, target:{area:"merchant",merchantId}, action, reason, expectedVersion }` | attributed changed/noop/refused/conflict result  |
| `merchantState.history` / `accountControls.history` | interactive MFA + live founder entitlement | `{ target:{area:"merchant",merchantId}, limit }` — explicit bounded limit             | attributed control results, newest first         |

Refunds and payouts carry their own scopes. Taking a payment and sending money back out are not the same authority. Bad destinations refuse as `pay.invalid_destination_ref` / `pay.destination_kind_mismatch` **before** any hold.

### Merchant statement (`merchant.statement.list`)

The page is one window, not the merchant's whole history. `from` and `to` are required (`pay.statement_range_required`). The span is at most 92 days (`pay.statement_range_too_wide`). One request resolves at most 2000 candidate ledger keys (`pay.statement_too_large`). Those two numbers are technical safety bounds so a read cannot walk every capture, settlement, refund, dispute, and payout the merchant has ever had. They are not a retention policy and not a fee.

Running balances need a ledger balance at `from`. `LedgerClient` does not expose one, so the response says `runningBalances: "within_range"` and `opening: null`. In that mode each line carries `windowNet`, the signed net of that line's account inside the window after the line (a debit is positive). `runningClearing` and `runningProceeds` are null and `runningReason` is `no_opening`. A negative window net is an outflow recorded without an opening balance, and the line stays `runningOrder: "clear"`.

When the client exposes `balanceAsOf`, `runningBalances` is `from_opening`, lines start from that opening, and `windowNet` is null. A reconstructed balance that would go negative is `runningOrder: "order_ambiguous"` and `runningReason: "order_ambiguous"`. Later lines for that asset drop their balances. The page still returns.

Same-timestamp lines from different ledger transactions follow `seq` or `sequence` when every line at that instant has one, otherwise the hash chain (`previousHash`). When neither a sequence nor a distinct chain position orders those transactions, the line is `order_ambiguous` in either mode.

One `merchant.statement.list` runs per merchant at a time. The slot is a row in `pay.merchant_statement_leases`, kept for at most 60 seconds and deleted when the scan finishes. This process also runs at most two scans at once. A second call for that merchant, or a third scan on that process, is `pay.statement_busy`. Those bounds are a concurrency limit. They are not a quota and not a fee. The scan does not hold a pooled connection across the ledger reads.

TODO: svc-ledger should grow a cursor that pages entries by account. This procedure should read that cursor instead of guessing ledger keys from pay rows.

`payment.refunds.get` loads the merchant id and fences before it parses an amount or reads the ledger. A malformed row the caller does not own is `pay.refund_not_found`.

`settlement.lifecycle` derives status from the timeline. When the status column is ahead of `settled_at` / `sent_at` / `failed_at` (migration 0073 did not backfill them), the read adds one synthetic event `{ at: null, timeKnown: false }` so the derived status is not lower than the column.

**HTTP:** `POST /webhooks/:railId` (public, signature-authenticated), `GET /health`, `GET /ready`, hosted checkout `GET /checkout?token=` / `GET /pay/link/:token` (public HTML; browser via edge `/api/pay/checkout?token=`).

### User money in and out

Everything above is **merchant** money — a third party pays a merchant. These are the other half: a **user's own** balance entering and leaving the book.

| Procedure            | Scope            | Input                                                 | Output          |
| -------------------- | ---------------- | ----------------------------------------------------- | --------------- |
| `deposit.credit`     | `admin:treasury` | `{ userId, assetId, amount, railId, railRef }`        | `Deposit`       |
| `withdrawal.create`  | `trade:withdraw` | `{ assetId, amount, railId, destination, clientRef }` | `Withdrawal`    |
| `withdrawal.get`     | `trade:read`     | `{ withdrawalId }`                                    | `Withdrawal`    |
| `withdrawal.mine`    | `trade:read`     | `{ limit? }`                                          | `Withdrawal[]`  |
| `withdrawal.balance` | `ledger:read`    | `{ assetId }`                                         | `{ available }` |

**Withdrawal limits (D-148, W-withdraw-05).** A per-customer cap by KYC tier, per transaction and rolling 24 hours, per asset, lives in `src/limits/`. It is off by default; `PAY_WITHDRAWAL_LIMITS=required` turns it on. The owner-set figures are rows in `pay.withdrawal_limits`, changed through `founderAdmin.limits.change`: setting a limit or raising either figure needs a second founder (bound to the exact change; `founderAdmin.limits.preview` returns the hash), cutting or clearing one needs one founder, and every change appends to `pay.withdrawal_limit_events`. The old `PAY_WITHDRAWAL_LIMITS_BY_TIER` setting is retired and stops the boot if set. A blank figure refuses (`pay.guard_withdrawal_limit_unset`), a hit refuses with the remaining allowance (`pay.guard_withdrawal_limit_exceeded`, field `remaining` on the refusal, `allowance` on the error data). The rolling sum counts every withdrawal state except `failed` and `canceled`, so a state added later counts until someone decides it should not. `withdrawal.limits` (`trade:read`) tells the caller their tier's figures, what the window has used and the most one withdrawal may be now; it refuses with the guard's own codes. The customer's tier is read per request from identity (`GET /internal/account/:userId`, needs `IDENTITY_URL`); without it `required` refuses every withdrawal with `pay.guard_withdrawal_tier_unwired`, and an identity failure refuses with `pay.guard_unavailable`, never a guessed tier. Also on `withdrawal.create` are the treasury exposure cap (platform-wide per asset, enforced only with `PAY_TREASURY_LIMITS=required`) and, for a user who owns a merchant with a legacy settlement of that asset, that merchant's payout policy: daily payout cap, beneficiary cap and approval threshold (enforced only with `PAY_MERCHANT_CONTROLS=required`).

**Screening desk (W-compliance-notices-02).** A withdrawal the screening guard holds for review becomes a case in `pay.screening_cases`, with the party, amount, asset and provider label saved at screening time and every step appended to `pay.screening_case_events` (append-only). `screening.cases.list` and `.get` read cases and `screening.sanctions.status` says whether the list is blank or named, with no list contents; all need `admin:compliance` in the pay module. `screening.cases.decide` (MFA) either upholds the match (final, one person) or releases it. A release needs a second person bound to the case and the reason (`pay.screening_release`), is refused for a refused case, a blank list, a payout, or when `PAY_SCREENING_RELEASE_TTL_SECONDS` is unset, and is spent once, by the next withdrawal of the same party and asset up to the case amount, before it expires; the release records which send key spent it, in the same transaction as the claim, so a retry of that send after a crash gets the same release again (never a second, never past its expiry or above its amount) and a rolled-back claim gives it back. A send whose own case was refused or upheld is never covered by another send's release. A spent release is the person's decision and is not re-screened at spend, so its time-to-live is the window. `screening.cases.rescreen` asks the screener again and a clear answer releases nothing. Not yet built: the deposit-side kind, `sanctions.list.import`, customer refusal copy, desk screens and payout release.

**Why these live here.** Value entering the book must come from a rail and value leaving goes out through one; the `RailAdapter` interface, the registry and both v1 adapters are in this service. The alternative was a second service learning about rails, or a money path with no rail behind it — which is a money path reconciliation has nothing to check against.

**Why the withdrawal is not in svc-trade.** `services/svc-trade/src/router.ts` says `trade:withdraw` "appears nowhere here, deliberately: it is an INTERACTIVE_ONLY scope that no API key may hold, which is what protects a leaked bot key from moving value off the platform." That reasoning is about the **surface**, not about where the scope lives — svc-trade is the exchange API that bots hit with long-lived keys. It is respected rather than worked around: the withdrawal lives where the rails live, and svc-trade stays a pure exchange API.

#### `deposit.credit` — operator-credentialed, never user-facing

A user who can call the thing that credits their own balance does not need to deposit. So:

- **`admin:treasury`**, which is in `INTERACTIVE_ONLY_SCOPES`. Both halves of that protection apply for free: a long-lived API key may **never** hold it, and a session without 2FA may not exercise it. `pay:write` would have let any merchant credit any user; `admin:write` is broad and not interactive-only.
- **`creditedBy` comes from the token**, never the body. Every unit of value entering this way names the operator who asserted it arrived.
- **Only rails on `PAY_OPERATOR_CREDIT_RAILS`** (blank refuses; owner may set `card-sandbox` explicitly). A hand-typed `crypto-native` credit would move `railBoundary('crypto-native')` away from the chain balance it mirrors, and reconciliation would report a discrepancy that is really a typo. Misconfiguring it fails at **boot**, not at request time.
- **No jurisdiction guard, and no tier check on the payee.** The matrix judges the user being served, and the principal here is an operator who is not the beneficiary — checking their tier measures the wrong person. And money that has already reached a rail must always be bookable: refusing to credit an unverified user does not undo their payment, it strands it at the boundary. The gate belongs on what a balance can **do**, not on being allowed to receive one.

#### `withdrawal.create` — the interactive path off the platform

- **`trade:withdraw`**, INTERACTIVE_ONLY: no API key may hold it, and `requireScope` refuses a session that has not passed 2FA. A normal session does not carry it at all — `auth.stepUp` in svc-identity mints the five-minute token that does.
- **`{ module: 'ledger' }`, not `{ module: 'pay' }`.** The matrix rule governing a user moving their own custodial balance is the rule for the module that **holds** it, and the ledger holds it (`custodial: true`, `OPEN_BASIC`). `pay`'s `full` tier governs merchant acquiring — third-party card money — a different risk and a different subject. Gating a withdrawal above the tier that admitted the value would build a one-way door: verified enough to deposit and trade, not verified enough to leave.
- **`clientRef` is required, not optional.** A timed-out request retried without one opens a second withdrawal, and a second withdrawal is a second debit. `clientOrderId` is merely recommended on an order because a duplicate order can be cancelled; there is no cancelling a payout.
- **The account comes from the token.** There is no `userId` input, so there is nothing to forge.

### Which rails are real — read this before believing a `sent`

| rail            | `mode`                      | counterparty                                                                                  | what a `payout` returns                                       |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `card-sandbox`  | `sandbox`, permanently      | a `Map` in `card-sandbox.ts`                                                                  | `po_<settlementId>` — a string this file invented             |
| `crypto-native` | derived from the chain port | `EvmLiveChain` when configured; else `MemoryChain` (dev) / `UnconfiguredChain` (staging/prod) | a real `txHash` on a live chain; `0xout…` / refusal otherwise |
| `bank-payout`   | `absent`, permanently       | nothing — sponsor bank / licence is a commercial socket                                       | never succeeds; `pay.rail_not_live` before any hold           |

**Live crypto-native** is wired when all of these are set:

```bash
PAY_CRYPTO_RPC_URL=…          # archive-capable JSON-RPC
PAY_CRYPTO_CHAIN_ID=…
PAY_CRYPTO_DEPOSIT_SOURCE=testnet # deposit addresses, test chains only; a provider source is injected at boot
PAY_CRYPTO_SIGNER=testnet     # test chains only; a provider signer is injected at boot
PAY_CRYPTO_ASSETS=ETH:native  # or ETH:native,USDT:0x…:6
```

That builds `EvmLiveChain` (`src/rails/evm-chain.ts`, `posture: 'live'`), starts the in-process watcher that POSTs signed webhooks with `PAY_CRYPTO_WEBHOOK_SECRET`, and makes `crypto-native` a live rail. Staging/prod then **omit** `card-sandbox` by default (`shouldRegisterCardSandbox`) so the boot posture gate can pass without `PAY_ALLOW_SANDBOX_RAILS`.

**Why sandbox gates still matter.** A withdrawal settled against a sandbox rail debits the user's real ledger balance, writes a fabricated reference into `withdrawals.rail_ref`, and answers `status: 'sent'`. The books still balance — only custody reconciliation can see the lie.

**The two gates** (`src/rails/posture.ts`):

1. **Boot.** `APP_ENV` of `staging` or `prod` with any sandbox rail registered **refuses to start**, unless `PAY_ALLOW_SANDBOX_RAILS=true` says so by name (logged loudly on every boot).
2. **Runtime.** `payout` and `refund` re-check at the call site, **before** the ledger moves — `withdrawal.create` refuses with `pay.rail_not_live` before a row or a hold exists.

`dev` and `test` without live config keep `MemoryChain` + `card-sandbox` as the fixture.

**What the owner must still obtain for production money:**

- A **production** (or public testnet) RPC, not only compose anvil — anvil proves the wiring; it is not a chain decision (`docs/decisions/local-dev-chain.md`).
- A real provider for the hot wallet signer and the deposit address source (HSM or signing service). Neither a key nor a seed phrase is a setting; the testnet implementations refuse mainnet, staging and prod.
- Live boot wires `PostgresBroadcastStore` (`pay.crypto_broadcasts`, migration 0004 + `signed_raw` in 0012) for multi-replica claim→putSigned→sendRaw→put. `MemoryBroadcastStore` remains the unit/local default when no store is passed to `defaultChainFor` in `dev`/`test`. staging/prod live chain **refuses to build** without a store — two replicas on the in-memory journal can double-send. DIRECTION §3.1 / D26-P1-P9: the signed raw is journalled **before** `eth_sendRawTransaction`; crash-resume rebroadcasts the identical payload (`claim` → `resume`) instead of signing a second spend. Put-before-receipt still closes the wait-for-inclusion window.
- Live boot also wires `PostgresChainWatcherCursorStore` (`pay.chain_watcher_cursors`, migration 0017) so the in-process watcher persists last-seen (block, tx hash, log index). A crash that re-drains the same finalization does not POST a second credit. No live chain config → no live chain → watcher never starts; `/pay` deposits stay a named refuse, not an invented inbound.
- **Card acquiring** — sponsor bank / BIN. Still a §13 commercial socket; `card-sandbox` is never it.

`/ready` and `railHealth` both carry `mode` now, because `healthy: true` was accurate and useless — a sandbox is reliably healthy at simulating.

> **Interface mismatch, flagged not papered over.** `RailAdapter.payout` takes a `SettlementInstruction`, which is merchant-shaped — it is the only payout shape §6.1 has. Every adapter uses `settlementId` purely as the payout idempotency key and reads `merchantId` not at all, so a user withdrawal passes its own id and the user id and works correctly. Generalising it to a `PayoutInstruction` is a change to a reviewed interface plus its conformance kit, so it belongs in its own PR (§15.2).

### PayFac — sub-merchant trees (§6.1)

A merchant may now have children. `merchants.parent_merchant_id` is the tree (NULL = top of its own tree, which is what every merchant already was), and `merchants.settling_party` is the spec's one hard design constraint made a column rather than an assumption — `docs/SPEC-PAY-VERTICALS-2026-08-02.md` (removed) §2: _"model the sub-merchant relationship so the settling party is a field, not an assumption."_

**This slice moves no value.** No ledger client, no recipe, no balance, no amount. A sub-merchant is a sovereign account exactly as a merchant is; the tree decides **who may ask**, never where money sits (Doctrine §0.6).

| Procedure                       | Scope       | Input                                                    | Output              |
| ------------------------------- | ----------- | -------------------------------------------------------- | ------------------- |
| `submerchant.create`            | `pay:write` | `{ parentMerchantId, userId, pricing: { feeBps }, … }`   | `SubMerchant`       |
| `submerchant.list`              | `pay:read`  | `{ merchantId, limit? }`                                 | `SubMerchant[]`     |
| `submerchant.get`               | `pay:read`  | `{ merchantId }`                                         | `SubMerchant`       |
| `submerchantPermission.grant`   | `pay:write` | `{ granteeMerchantId, subjectMerchantId, area, reason }` | `PermissionEvent`   |
| `submerchantPermission.revoke`  | `pay:write` | `{ granteeMerchantId, subjectMerchantId, area, reason }` | `PermissionEvent`   |
| `submerchantPermission.list`    | `pay:read`  | `{ subjectMerchantId }`                                  | `PermissionGrant[]` |
| `submerchantPermission.history` | `pay:read`  | `{ subjectMerchantId, limit? }`                          | `PermissionEvent[]` |
| `submerchantPermission.areas`   | `pay:read`  | –                                                        | the area vocabulary |

#### The two checks, which are not the same check

1. **Scope** — structural and absolute. The caller's merchant node must be an ancestor of the subject, or the subject itself. **No grant widens this.** A parent cannot read a sibling subtree, a child cannot read upward, and two payfacs are invisible to each other.
2. **Area** — a permission, and only for a subject that is not the caller itself. A merchant holds every area over its **own** node. Over a descendant it holds an area only if it is the **root** of that tree (the node with the platform relationship, which §2 of the spec makes liable for everyone beneath it), or a live grant says so.

**The acting node comes from the token.** There is no `actorMerchantId` on the wire. `pay:write` is a merchant's own scope held by every merchant on the platform, so a merchant node taken from a request body would leave the fence working perfectly while measuring the wrong actor.

**Delegation flows down, and only what you hold.** A non-root node cannot self-grant, cannot grant laterally (one child never gets authority over another), and cannot grant an area it was not given. Onboarding writes exactly two default areas to each intermediate ancestor — `merchant.profile` and `submerchant`, visibility only. **No value-shaped area is held by any non-root node until somebody grants it by name and says why.**

**`pay.merchant_permission_events` is append-only**, enforced by a trigger. A revoke is a new row. "Who could refund this sub-merchant's payments on the 3rd" is argued from in a dispute, and an editable answer is not evidence.

#### The "14 permission areas" — said out loud

The tracker row is titled _"PayFac mode — sub-merchant trees, 14 permission areas"_. **That list has never existed.** The phrase is one title string copied between `tooling/tracker/features.mjs`, `tooling/coverage.yaml`, `INTAFACED_DEFINITIVE_BUILD.md` and three board renders derived from them; `docs/PAY-LANE-HARVEST-AND-BUILD-PLAN-2026-08-08.md` (removed) §2 found the same thing independently and §6.3 puts _"enumerate them, or drop the claim from the title"_ on the owner's list.

So this ships the **mechanism**, and `PERMISSION_AREAS` in `src/submerchants.ts` is **eleven** areas — every one that names a surface this service actually has: `merchant.profile`, `checkout.profile`, `payment.link`, `payment`, `payment.refund`, `settlement`, `settlement.payout`, `webhook`, `kyb`, `submerchant`, `permission`. Padding the list to hit a number in a title would be inventing product law inside an implementation. `area` is stored as text, so the twelfth is a one-line change and no migration.

#### What is deliberately NOT here

- **Settling a sub-merchant out of our account.** `settlingParty` accepts `'self'` only and refuses everything else by name (`pay.submerchant_settling_party_unsupported`). That is acquiring — a sponsor bank and an acquiring BIN, which `docs/SPEC-PAY-VERTICALS-2026-08-02.md` (removed) §8 puts on the owner's list and `socket.psp-partners` tracks. The column exists so adopting a partner later is configuration rather than a rewrite; it is not a switch this service can throw.
- **Areas on the gateway surface (W5).** Money and merchant procedures in `router.ts` / `public-rest.ts` call `assertMerchantAreaAccess` with the matching area (`payment`, `payment.refund`, `settlement`, `settlement.payout`, `payment.link`, `webhook`, `kyb`, …). Self still holds every area. A parent without a grant is `pay.submerchant_permission_denied`; a stranger stays `pay.merchant_forbidden`. Pins: `merchant-ownership.test.ts`.
- **Split payments and sub-merchant fee routing.** Ledger recipes, Class M, and the owner's sign-off (`docs/PAY-LANE-HARVEST-AND-BUILD-PLAN-2026-08-08.md` (removed) §6.4).
- **Sub-merchant KYB workflow and document capture.** Top-level merchant digital KYB (submit + operator decide + history) ships under `kyb.*` / mig 0013; document-capture vendor integration and sub-merchant KYB remain residual. Card acquiring stays `socket.psp-partners`.

### Error codes

`pay.submerchant_out_of_scope` and `pay.submerchant_permission_denied` map to **FORBIDDEN**, and they are different questions on purpose: the first says the node is not yours to look at, the second says it is yours to look at and not yours to act on. `pay.submerchant_user_already_merchant` maps to **CONFLICT** — one merchant per sovereign account is a database rule and nothing the caller resends fixes it. `pay.submerchant_cycle` is **CONFLICT** rather than a 500 so the message naming the corrupted node survives to an operator.

Also: `pay.submerchant_grant_lateral`, `pay.submerchant_grant_self`, `pay.submerchant_grant_redundant`, `pay.submerchant_revoke_redundant`, `pay.submerchant_area_unknown`, `pay.submerchant_too_deep`, `pay.submerchant_reason_required`, `pay.submerchant_pricing_invalid`, `pay.submerchant_settling_party_unsupported`, `pay.submerchant_not_onboarded`.

`pay.rail_declined`, `pay.rail_failed`, `pay.capture_exceeds_authorized`, `pay.partial_capture_unsupported`, `pay.refund_exceeds_captured`, `pay.refund_in_flight`, `pay.settlement_in_flight`, `pay.settlement_desynced`, `pay.rail_amount_mismatch`, `pay.invalid_transition`, `pay.nothing_to_settle`, `pay.fee_exceeds_gross`, `pay.merchant_pricing_invalid`, `pay.webhook_invalid`, `pay.webhook_unmatched`, `pay.rail_unknown`, `pay.rail_not_creditable`, `pay.deposit_conflict`, `pay.withdrawal_not_found`, `pay.withdrawal_conflict`, `pay.rail_not_live`, `pay.destination_kind_mismatch`.

`pay.destination_kind_mismatch` is refused **before** any ledger hold: a crypto payout cannot name a bank IBAN (and the reverse). Retrying with the same wrong kind never moves money.

`pay.settlement_in_flight` and `pay.settlement_desynced` map to **CONFLICT**. The first refuses a pre-settlement refund while a pending window has frozen the payment (clearing must not be drained under a frozen gross). The second refuses to post a settlement whose live captured−refunded totals no longer match the freeze — better a stuck pending row than a ledger entry funded by someone else's capture.

`pay.deposit_conflict` and `pay.withdrawal_conflict` map to **CONFLICT**, never BAD_REQUEST: the caller reused a business key for different numbers, and nothing they resend fixes it.

`pay.rail_not_live` maps to **SERVICE_UNAVAILABLE**, never INTERNAL_SERVER_ERROR. The request was well-formed; the platform has no rail that would actually move the money. A 500 reads as "try again", and this is the one condition retrying can never fix.

---

## Events

### `payment_events` — the internal append-only history

This is the state history §6.1 requires, and it is the truth this service reasons from. Ordered by `seq` (a `bigserial`), not by `ts`: every event appended inside one transaction shares a transaction timestamp, and a history that cannot order a capture against a refund is not a history.

| Event                 | Appended when                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `created`             | A payment row exists. Nothing has moved.                                                                                    |
| `rail.authorize`      | A rail answered an authorization request (ok or not).                                                                       |
| `rail.pending`        | The rail took the request but has not completed it — on `crypto-native`, the transfer has not landed or is not deep enough. |
| `authorized`          | The rail authorized. The amount recorded is what the RAIL authorized.                                                       |
| `rail.capture`        | A rail answered a capture request.                                                                                          |
| `captured`            | Value entered the book. Carries the ledger transaction id.                                                                  |
| `refund.posted`       | The merchant has been debited and a refund is about to be sent.                                                             |
| `rail.refund`         | The rail answered the refund request.                                                                                       |
| `refunded`            | The refund left the rail.                                                                                                   |
| `refund.reversed`     | The rail refused; the ledger posting was reversed.                                                                          |
| `settlement.included` | The payment is frozen into a settlement window.                                                                             |
| `settled`             | The window posted to the merchant's ledger account.                                                                         |
| `failed`              | The rail declined, or a failure webhook arrived.                                                                            |
| `webhook.<type>`      | A verified rail delivery. Carries `rail_event_id`, which is **unique** — this is the dedupe.                                |

### NATS

**svc-pay publishes no NATS subjects yet.** Not an oversight: the bus is a contract, and §15.2 / AGENT_PROTOCOL §2 require a `packages/events` catalog PR — reviewed on its own — before a producer emits anything. `intafaced.pay.payment.captured` and `intafaced.pay.settlement.completed` are the two consumers will want; they land in the catalog first.

**Consumes:** nothing.

---

## Ledger

Every value movement is a recipe. This service holds no balance of any kind (Doctrine §0.6).

| Recipe                 | Reason code               | Accounts                                                               |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `paymentCapture`       | `payment.captured`        | rail boundary → `pay:clearing:<merchantId>`                            |
| `merchantSettlement`   | `pay.settled`             | `pay:clearing:<merchantId>` → merchant available + `houseFees('pay')`  |
| `paymentRefund`        | `payment.refunded`        | clearing (pre-settlement) or merchant available (post) → rail boundary |
| `paymentRefundReverse` | `payment.refund.reversed` | rail boundary → back where the refund came from                        |
| `withdrawHold`         | `withdraw.held`           | available → purpose-keyed hold (payout / withdrawal in flight)         |
| `withdrawSettle`       | `withdraw.settled`        | hold → rail boundary (completed)                                       |
| `withdrawReverse`      | `withdraw.reversed`       | hold → available (refused)                                             |
| `deposit`              | `deposit.credited`        | rail boundary → user available                                         |
| `depositReverse`       | `deposit.reversed`        | user available → rail boundary (rewritten deposit block)               |

The three `withdraw*` recipes serve **both** outbound paths — a merchant payout keyed on `<settlementId>:<attempt>`, and a user withdrawal keyed on `<withdrawalId>:<attempt>`. Same shape, same reasoning, one set of recipes.

For D26-P1-P4, `settlement-ledger.ts` makes that constraint executable: both
`bank` and `crypto` settlement destinations produce only the existing
`withdrawHold` → `withdrawSettle` / `withdrawReverse` requests. Rail adapters
own the destination difference; svc-pay does not assemble entries or invent a
bank-specific book. `bank-payout` remains `absent` and refuses before the hold
until the Class X sponsor-bank socket exists, while configured `crypto-native`
can complete the same recipe plan against a real chain.

**`merchantClearing(merchantId, assetId)`** is a new account constructor: a `module`-owned account per merchant, per asset. It answers "a payment was captured but not settled — whose funds are those?" as a balance rather than an investigation. `sum(merchantClearing(m))` is exactly what svc-pay owes merchant `m` right now, readable from the ledger without touching a single svc-pay table — which is what makes reconciliation between the two meaningful.

### Idempotency keys — all business keys, never random

| Key                                                       | Governs                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment.capture:<paymentId>`                             | A payment is captured once, however many times the webhook is delivered.                                                                                                                                                                        |
| `payment.refund:<paymentId>:<refundId>`                   | One refund, one posting. Namespaced by payment so merchant ids do not collide across payments. `<refundId>` is required on tRPC (a retry must carry the same id); only `PayService` itself still derives `<paymentId>:<n>` when none is passed. |
| `payment.refund.reverse:<paymentId>:<refundId>`           | The reversal of that refund.                                                                                                                                                                                                                    |
| `settlement:<merchantId>:<window>:<assetId>`              | A window settles once, per asset.                                                                                                                                                                                                               |
| `withdraw.hold\|settle\|reverse:<settlementId>:<attempt>` | One merchant payout attempt.                                                                                                                                                                                                                    |
| `withdraw.hold\|settle\|reverse:<withdrawalId>:<attempt>` | One user withdrawal attempt.                                                                                                                                                                                                                    |
| `deposit:<rail>:<railRef>`                                | A rail reference is credited once, however often it is redelivered.                                                                                                                                                                             |
| `deposit.reverse:<depositId>`                             | A rewritten block reverses that deposit once. A second report returns the first row.                                                                                                                                                            |

> **Why the asset is in the settlement key.** §6.1's settlement is keyed on merchant and window. A merchant taking USDT and BTC on the same day has two settlements, and without the asset in the key the second would find the first's transaction, return it, and strand a whole currency's takings in clearing. The `settlements` table carries an `asset_id` column for the same reason: `gross`/`fees`/`net` are meaningless without one.

### Order of operations, and whose funds are stranded

The direction of the money decides the order:

- **Inbound (capture):** the rail moves first, the ledger books second. We only book value we know has arrived. A crash in between leaves money captured at the rail and not yet in the book — the classic. Nothing is lost: both halves are keyed on the payment id, so re-running finishes the job.
- **Outbound (refund, payout):** the ledger moves first, the rail second. The merchant must be shown to have the money before any of it goes somewhere irreversible; a post-settlement refund they cannot cover fails at the ledger, before the rail is asked. A crash in between leaves the book correct and only the status projection behind. If the rail then refuses, the ledger posting is reversed in the same call.

A refund whose id is already in flight is **refused**, not re-sent. Live crypto receives a durable `refundId` (M226-02) so a process restart reuses the same outbound broadcast key; card-sandbox ignores it. The **service** still refuses re-entry while `refund.posted` has no terminal `refunded` / `refund.reversed` — "send it again and hope" is how one refund becomes two on a rail that cannot dedupe.

### User money: whose funds are stranded, per branch

**Deposit** (inbound — the rail already moved, in the real world):

| Crash point                  | Whose funds, and where                                            | Recovery                                                                      |
| ---------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Before the claim row commits | Nobody's in the book. Value sits at the rail with no record here. | Re-run. Nothing was recorded, so nothing is inconsistent.                     |
| Claimed, not yet booked      | **The user's** — at the rail, not in the book. Row is `pending`.  | Re-run the same `(rail, railRef)`; `deposits_status_idx` lists exactly these. |
| Booked, row not flipped      | Nobody's. The user has their money; the row is one status behind. | Re-run: the ledger key is identical, so the post is a no-op.                  |

**Withdrawal** (outbound — the ledger moves first):

| Crash point                  | Whose funds, and where                                                                                                | Recovery                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the hold posts        | Nobody's. The balance is untouched.                                                                                   | Re-run on the same `clientRef`.                                                                                                                                 |
| Insufficient funds           | Nobody's. Nothing moved, and it failed **before** a rail was asked.                                                   | The row records `ledger.insufficient_funds`.                                                                                                                    |
| **Held, rail never asked**   | **The user's, immobilised** — out of `available`, in `withdraw:<id>:<attempt>`. The only branch where value is stuck. | Re-run on the same `clientRef`: the hold key is identical so it moves nothing, and the rail is then asked. `withdrawals_status_idx` lists everything in `held`. |
| Rail refused                 | Nobody's. Reversed to `available` **in the same call**, `attempts` advances.                                          | None needed. Retrying takes a fresh hold key.                                                                                                                   |
| Rail sent, settle not posted | Nobody's is lost, but **the platform is short**: the rail paid out and the book still shows a hold.                   | Re-run: the settle posts once, and the rail is not re-asked because its idempotency key is the same string.                                                     |

The one genuinely stuck state is `held`, which is exactly why it is a real status with its own index rather than something inferred.

---

## Rails

`src/rails/rail-adapter.ts` is the interface, exactly as §6.1 specifies — `id`, `capabilities`, `authorize`, `capture`, `refund`, `payout`, `verifyWebhook` — plus `health()`, taken from the shape `packages/venue-adapter` already uses for liquidity venues.

| Adapter         | What it is                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto-native` | **Real.** Accepts on-chain assets and settles them to the ledger. Talks to `CryptoChainPort`, never to a node directly.                                                                                                 |
| `card-sandbox`  | A **mock acquirer**, not a mock adapter. The state machine, decline codes, refund arithmetic, signed webhooks and idempotency are all real; only the counterparty is simulated. It runs the full flow end to end in CI. |

### `crypto-native`: authorize and capture are not what they are on a card

A chain has no auth hold and nothing to complete. So:

- **authorize** means "a transfer to this payment's acceptance address has reached `minConfirmations`". Below the threshold the answer is `pending`, not `authorized` — a shallow transaction can still be reorganised away, and a merchant who ships against one has shipped against nothing.
- **capture** is an accounting act, and it re-reads the chain rather than trusting a decision made minutes ago. A reorg between the two is caught.

It also handles what payers actually do: **underpayment** and **wrong token to the right address** both fail the payment while reporting the address, the transaction and the sender, so the funds are recoverable rather than merely lost. An **overpayment** is booked at what arrived, because booking less would strand the difference.

### Webhook verification

Constant-time, via `crypto.timingSafeEqual`, over the **raw body** signed together with a timestamp. Length is checked separately first, because `timingSafeEqual` throws on a length mismatch and an unhandled exception on a public endpoint is a denial-of-service surface. Non-hex signatures are rejected outright: `Buffer.from('zz','hex')` is empty, and two empty buffers compare equal — a signature of nothing verifying nothing. Stale timestamps are replays. Nothing throws, whatever arrives.

A verified delivery is still shape-checked: an amount that is a JSON number is rejected even when the signature is perfect.

### Adding a rail — the conformance kit (§6.3)

```ts
import { runRailAdapterConformance } from '@intafaced/svc-pay/rails';

runRailAdapterConformance('acme-acquirer', async () => ({
  adapter: new AcmeAcquirerAdapter({ ... }),
  reset: async () => { ... },
  primeAuthorization: async (intent) => { ... },
  signWebhook: (event) => ({ ... }),
  signRaw: (body) => ({ ... }),
  failNext: () => { ... },
  payoutDestination: () => ({ kind: 'bank', ref: '...' }),
}));
```

**Any future adapter must pass this kit before merge.** It asserts identity and capability declaration, health and staleness, the `RailResult` contract (`ok === (status !== 'failed')`, money is always a bigint, a failure always carries a machine-readable code), authorize/capture/refund/payout idempotency on business keys, refund arithmetic including over-refund across partials, webhook verification against tampering, forged and wrong-length signatures, replay, garbage and correctly-signed-but-malformed payloads, and that rail failures surface as results rather than exceptions and leave nothing half-done.

What the kit asserts is exactly what the core is entitled to assume. That is what makes §6.1's "drop in later as adapters with zero core changes" a testable claim instead of a hope.

---

## USD → USDT conversion (sandbox)

Live mode refuses to boot. With no testnet key, quote and execute refuse. They do not invent a fill.

**Orphan holds.** `founderAdmin.conversion.holds.sweep` (`sweepOrphanHolds`) stays founder-triggered. The same pass also runs every 5 minutes. One replica holds a session try-lock for the pass; a busy lock releases nothing. Run it after any resolve, and after a crash, so a hold whose conversion row is failed or gone is released. The amount released is the hold the ledger still has. A live row, including `placing`, is left alone.

**Late fills.** Detection is not on the quote or execute path, and it does not book. A timer calls `sweepLateFills` once a minute, and a founder can run the same pass with `founderAdmin.conversion.lateFill.sweep` (that call skips the backoff wait). One replica holds a session try-lock for the tick. A busy lock makes no venue calls. Each tick calls the venue for at most 8 rows, so the lock cannot sit in front of quote and execute lookups. The venue search is only `placing_at` minus 1 minute through `placing_at` plus 10 minutes (the window in which the venue could have accepted the order). The same window is what resolve and reconcile use. Each successful check stamps `last_checked_at` and sets the next check at most 1 minute later, then 5, then 15, then 60. The wait is jittered under that cap and is the same on every replica. A venue or rate error does not stamp the row, is logged, and is retried on the next tick. It does not block quotes or executes. Only a found late fill does.

The sweep stops calling the venue for a resolve-absent row 7 days after the absent-resolve confirmation (or `placing_at`, then `created_at`, when that confirmation is missing). It sets `late_fill_check_final_at`. That horizon is technical: it bounds how long a miss is re-queried. It is not a quote TTL. A founder force does not reopen a final row. A fill that appears after the horizon is not auto-detected.

A found fill writes a `pay.conversion_late_fill` audit row and blocks new quotes and executes with `pay.conversion_late_fill_halt`. Nothing is booked. Clearing a conversion halt, including a halt that was set for another reason, does not lift that block.

**Acknowledgement.** Two founders. `founderAdmin.conversion.lateFill.propose` names how the fill was settled (a sentence, not an amount) and returns a hash bound to the audit row. A different founder calls `founderAdmin.conversion.lateFill.confirm` with that hash. Rejecting leaves the block in place. Confirming records the sentence and lets quotes and executes proceed. It does not book the fill and it does not clear a halt.

**Booking.** Separate from a hand-written sentence. `founderAdmin.conversion.lateFill.book.propose` fetches the venue and returns a hash bound to the audit row and that evidence. The body has no amount. A different founder calls `founderAdmin.conversion.lateFill.book.confirm` with the hash. Confirm fetches the venue again and posts only when the evidence still matches. The post is `fxConversionLateFill`. When merchant clearing covers the filled USD, that USD leaves clearing, the merchant is credited the net USDT, and the fee and spread are the original order's, pro-rated by the venue fill. The idempotency key is the audit row id. When clearing cannot cover, or the fill is under the original minimum, the venue legs go to treasury `pay:fx-inventory` only: inventory is short the filled USD and long the gross USDT the venue delivered. The merchant is not credited and no fee is taken. The merchant keeps the USD the absent-resolve already restored. A `pay.conversion_late_fill_shortfall` audit is written. Confirming the book also writes the confirmed acknowledgement, sentence `booked via late-fill book <requestId>`, so the quote halt lifts in that same two-founder step. `PAY_CONVERSION_MODE` still defaults to off. Nothing on the timer posts a fill.

## Kill-switch

`module.pay` in the admin console — the module kill-switch beats every other flag (`packages/config/src/flags.ts`). With it off, no procedure in this service serves. `pay.payfac` and `pay.laneA` gate features not built here.

## Halts

A halt stops one operation (intake, conversion, payout, or settlement) for everyone, one merchant, one user's withdrawal, or one rail. Auto-trip stays off until `PAY_HALT_AUTOTRIP_FAILURES` or `PAY_HALT_AUTOTRIP_RAIL_FAILURES` is a positive integer. There is no default count. With both unset, a payout, withdrawal, or refund does not take the auto-trip lock.

Adapter throws count per occurrence: N retries of one stuck payout can trip the merchant. That is fail-closed and intended. A generic `rail.failed` without a rail-health code never counts.

---

## Running it

```bash
pnpm --filter @intafaced/svc-pay db:migrate      # apply, --down to reverse
pnpm --filter @intafaced/svc-pay test            # needs Postgres on :5433; skips cleanly without it
pnpm gate svc-pay
```

Tests run against real Postgres (`postgres://svc_pay:svc_pay@localhost:5433/intafaced`) with `MemoryLedger` as the ledger — legitimate because the ledger conformance suite proves the reference implementation and svc-ledger's Postgres engine behave identically (§4.4). Postgres is real because the payment row / event log / ledger interaction is exactly where a bug would hide, because the append-only guarantee is a database trigger an in-memory fake would quietly not have, and because the deposit and withdrawal idempotency **is** a unique index.

The two Postgres suites bring the schema up under a shared advisory lock and own disjoint tables — vitest runs test files in parallel, and both re-asserting the same CHECK constraints at once deadlocks.

### Configuration worth knowing

| Variable                    | Default       | Why                                                                                                                                        |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAY_OPERATOR_CREDIT_RAILS` | unset refuses | Rails an operator may credit a deposit on by hand. Owner may set `card-sandbox` explicitly. Widening it is a deliberate operator decision. |

## Founder merchant controls and admitted payout recovery

`accountControls.getState`, `history` and `change` authenticate the original signed founder principal with existing interactive login scopes. Every request checks current identity entitlement, active interactive MFA session and expiry through identity. Founder entitlement authorizes these controls without granting unrelated broad admin or treasury scopes. Service contexts, non-founders, API keys, subaccount credentials and supplied actor fields cannot provide founder authority. Either founder can act independently; merchant controls do not consume the unrelated KYB or treasury two-person approvals. Legacy `merchantState.set` is the same strict reason/request-UUID/version command as `accountControls.change`; its former shared-operator approval shape is rejected. Legacy status history records `identity.operator_entitlement` as the actual authorizing authority rather than falsely claiming an admin scope.

Changes own the merchant `FOR UPDATE` guard shared by existing new-payment, authorization, discretionary-capture and payout-admission `FOR SHARE` checks. State, attributed append-only history and actor-bound canonical request replay commit together. Refusal/no-op/version-conflict are explicit outcomes. Closed merchants cannot be restored; a restricted pending merchant restores to pending, with its existing KYB unchanged. Authorization refusals never disclose target state. History requires an explicit bounded limit.

A payout freezes its settlement, attempt/business key, user, decimal-string net amount, asset, original rail and destination in an immutable owner record **before** holding funds. Recovery loads that record instead of inferring admission from a hold balance or rereading a mutable destination. Changed recovery inputs refuse before altering the destination store. An old hold without an owner admission is `pay.payout_admission_missing`, requiring an attributed recovery decision rather than a guessed destination. A posted settlement under suspension cannot create a new payout admission.

Each settlement's processing is serialized on a reserved PostgreSQL connection. Rail acceptance/refusal is committed independently before ledger completion and its SQL projection. Original admitted recovery can finish after suspension and after a hold, rail, ledger or projection crash; accepted rails are not re-asked once their durable outcome exists. Refused attempts reverse through ledger-client and advance the attempt once. Every amount remains a decimal string at persistence boundaries and scaled bigint in recipes; these records are instructions and outcomes, never a second balance book.

### Identity decision boundary

Production boot always installs the reviewed identity decision client. Missing identity URL or the distinct pay-owner admission key refuses fresh operations with `pay.identity_admission_unavailable`; there is no local-only boot fallback. Isolated test constructors may omit the port to exercise local merchant guards. Each fresh payment creation, authorization, capture and payout has its own immutable original prepared intent and `identity_requested` marker committed before requesting a grant. Grant/finalization holds the merchant SHARE guard. A merchant restriction takes the exclusive guard and resolves/cancels every pending marked payment and payout intent before committing; missing, incomplete or failed drains refuse the restriction and preserve those records. Cancellation is retained, so a late grant retry cannot acquire fresh authority after the restriction. A lost acknowledgement may resolve to an already-issued original grant and recover that original operation. A grant never describes completed money movement.

Whole-identity serialization also requires the matching durable identity decision service and its freeze guard, configured with `IDENTITY_PAY_ADMISSION_SECRET` matching pay's `IDENTITY_ADMISSION_SECRET`. These owner keys must be distinct from generic read/service and trade keys. Direct tRPC and merchant REST mutations derive credential authority from the real principal; hosted checkout, provider callbacks and scheduled operations use server-derived merchant policy. Hosted checkout commits the original create intent with its prepared payment/session, obtains the create grant before handing out any instruction, and separately admits authorization. A cancelled original create cannot be authorized. Creation accepts an optional request UUID for original recovery; REST maps the existing actor/idempotency key deterministically to that UUID. Direct PayFac create, authorize, capture and payout preserve the original parent actor and session/API-key/subaccount credential through explicit `payfac_credential` authority. Pay owns the live root relation or exact grant-event ID/sequence; it derives and revalidates that proof under the child merchant SHARE guard. Identity checks both the child owner and original parent identity/credential. Root authority uses the real root relation without an invented grant event. An explicit permission revoke takes the same child UPDATE guard and resolves/cancels all matching marked payment/payout intents before appending its immutable revoke event. Missing, failed or incomplete drains refuse the cutoff. The former delegate cannot initiate work through the route after revocation; owned recovery can finish an original resolved grant with its unchanged payload, rail and destination. This does not authorize new operations after cutoff. There is no service reparenting path; any future ancestry writer must adopt this guard and drain protocol.

### Database and recovery operation

1. Apply `0018_pay_founder_controls_admission.sql` through the service migration runner before boot. The runner serializes competing boots and commits DDL with its journal atomically; up/down/reapply is exercised on isolated PostgreSQL. Its down pair removes these records/columns; preserve an encrypted verified backup before reversing populated storage.
2. Configure identity's real URL, matching edge-principal secret and general service credential for live founder entitlement checks. Identity decision traffic uses its separate per-owner admission key.
3. Investigate unresolved prepared/requested records through restricted service operations. Never delete them or release a hold merely because a request timed out; resolve the original identity decision and use the recorded original payout.
4. Set the operator-history retention/export policy and prove backup restore before live launch. Append-only triggers reject edits/deletes; corrections are new attributed actions.

The PostgreSQL suite injects a SQL failure after successful rail and ledger completion, verifies recovery under suspension without a second transfer, verifies hold-crash recovery, changed-destination refusal, concurrent payout dedupe and reversal-projection recovery. Founder/control tests cover version races, both actors, legacy bypass refusal, immutable audit and pending-decision drain failure/cancellation/lost acknowledgement.

## Service keys: ledger calls

The ledger client signs with svc-pay's own key when `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set (`dual` also sends the shared secret, `keypair` the key only); unset, it signs with the shared secret as before. Other outgoing calls still use the shared secret and move in their own PRs. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: inbound doors

The internal doors (due-subscription run, subscription cycle journal, capture reconcile, merchant team email claim, owner pay scopes, pay step-up grant, merchant watch metrics) name the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
