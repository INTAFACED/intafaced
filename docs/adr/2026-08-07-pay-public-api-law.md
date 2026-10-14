# ADR: `pay.public-api` — the merchant surface, and what it may not become

**Status:** accepted  
**Status note:** **Accepted — 2026-08-07.** Product law for tracker row `pay.public-api` ("Public REST + webhooks + sandbox (§9)").
**Decision owner:** repo owner. **Class:** M (money path).
**Reason this exists:** the row was read as "generate OpenAPI from the zod schemas we already have". It is not. There are no REST routes to document — `svc-pay` speaks tRPC to our own edge, and a merchant is not a user with a JWT. This is a product surface, and the parts that need deciding are the parts nobody writes down.

---

## 0 · Plain English

Merchants want to charge cards from their own servers. Today the only way in is our own front end.

This says what that API looks like, and — more usefully — what it is not allowed to do. Almost everything it needs already exists behind tRPC: create a payment, authorise, capture, refund, list, payment links, checkout sessions, balances. **This is a new door onto built rooms, not a new building.**

---

## 1 · What already exists (so nobody rebuilds it)

`services/svc-pay/src/payment-service.ts` and `router.ts` already implement, behind `scopedProcedure`:

| Capability                                                                   | Status       |
| ---------------------------------------------------------------------------- | ------------ |
| `createPayment` · `authorize` · `capture` (full only) · `refund`             | built        |
| `get` · `list` · `history`                                                   | built        |
| merchants: `create` · `me` · `submitKyb` · `profile` · `balances`            | built        |
| payment links: `createLink` · `listLinks` · `deactivateLink` · `resolveLink` | built        |
| checkout sessions: `open` · `status` · `expireCheckoutSessions`              | built        |
| merchant status history + writer                                             | built (#800) |
| rails: `RailAdapter` port, card sandbox, crypto-native, posture              | built        |

**Nothing in this ADR authorises reimplementing any of it.** The REST layer is a translation, and any behaviour that differs between REST and tRPC is a defect in the REST layer.

---

## 2 · The decisions

### 2.1 Auth is an API key exchanged for a principal — not a new mechanism

Merchants authenticate with `ifc_…` API keys, which already exist (`svc-identity` `apiKeys`, minted in `auth/passwords.ts`, exchanged by `svc-edge` `principal-exchange.ts`).

**Decided:** the public API is reached through `svc-edge` like everything else, and the edge exchanges the key at identity exactly as it does now. `svc-pay` continues to receive a signed principal and never sees a raw key.

**Rejected:** a second auth path inside `svc-pay`. Two ways to prove who you are is two ways to get it wrong, and the money service is the worst place to hold the second one.

### 2.2 Idempotency is required on every mutating call, and is a business key

**Decided:** every POST takes an `Idempotency-Key` header. It is **required**, not optional — an omitted key is a `400`, never a silently non-idempotent charge.

The key maps onto the discipline `ids.ts` already states: _"Idempotency keys are business keys … never `crypto.randomUUID()`. A retry must find the original."_ A repeated key with an identical body returns the original result; a repeated key with a **different** body is a `409`, because that is a caller bug and answering it either way is worse than refusing.

### 2.3 Money on the wire is a decimal string, and the API says so

**Decided:** amounts are decimal strings with an explicit asset, never minor units and never a number. This is doctrine (§4.2, CLAUDE.md #3) and it is also the single most common integration bug in payment APIs — `1.10` arriving as `110` or as `1.1000000000000001`.

The API is not free to adopt the conventional `amount: 110, currency: "usd"` shape, because our ledger is not free to.

### 2.4 Webhooks are signed, replayable, and at-least-once

**Decided:**

- HMAC-SHA256 over `timestamp + "." + raw body`, in a `X-Intafaced-Signature` header, with the timestamp inside the signed payload so a captured event cannot be replayed later.
- **At-least-once, with the event id as the dedup key.** A merchant will receive duplicates and must be told so in the documentation rather than discovering it.
- Delivery is retried with backoff; a permanently failing endpoint is disabled and surfaced on the merchant's dashboard, never silently dropped.
- The event body carries **state, not instructions**: `payment.captured` with the payment's current shape, so a merchant who missed three events and refetches is never worse off than one who processed all three.

**Rejected:** signing the parsed JSON. Signature verification must work on bytes the merchant received, or it fails on whitespace.

### 2.5 Sandbox is a rail posture, not a separate deployment

**Decided:** sandbox reuses the rail posture that already exists (`rails/posture.ts`, `CardSandboxAdapter`, `VALUE_MOVEMENT_POLICY`). A sandbox key routes to the sandbox rail; a live key may not, and `assertRailMayMoveValue` already refuses that.

**Rejected:** a parallel sandbox stack. Two stacks means the thing merchants test is not the thing that runs, which is the entire point of a sandbox.

### 2.6 Errors keep the `pay.*` vocabulary

**Decided:** the existing internal codes are the public codes, in a stable envelope. A refusal names what to do next, in the house style — `pay.rail_operation_unsupported` already says "NOTHING WAS ATTEMPTED" because the first question an operator has is whether anything needs unwinding. A merchant's first question is the same.

**Rejected:** mapping to a competitor's error taxonomy. `svc-trade` speaks CCXT because bots already speak CCXT and that is a real interop win. There is no equivalent lingua franca for payments; adopting one vendor's would name a vendor (§0.7) and buy nothing.

### 2.7 Versioned at `/v1`, and additive-only within a version

**Decided:** `/api/pay/v1/...`. Within a version, only additive change. A field is never repurposed and never silently narrowed — merchants cannot redeploy on our schedule.

---

## 3 · What this may NOT become

| Never                                                        | Why                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| A second money book                                          | Doctrine §0.6. Balances stay in `ledger-client`; the API reports, it does not hold.                             |
| A path that moves value on a sandbox rail in an enforced env | `assertRailMayMoveValue` already refuses; the REST layer must not acquire an exception                          |
| A second auth mechanism inside `svc-pay`                     | §2.1                                                                                                            |
| Reimplementation of anything in §1                           | The REST layer translates; divergence is a defect                                                               |
| A live acquirer relationship implied by shipping this        | Class **X**. This is the API. Who actually acquires is an owner decision and a contract (`socket.psp-partners`) |
| Minor-unit integer amounts                                   | §2.3                                                                                                            |

---

## 4 · Sequence, so it can ship in pieces

1. **REST translation + OpenAPI + auth + idempotency** — `@fastify/swagger`, `@fastify/swagger-ui`, `fastify-type-provider-zod` over the schemas that already exist. Read paths first: `get`, `list`, `balances`. No new behaviour, so no new money risk.
2. **Mutating paths** — `create`, `authorize`, `capture`, `refund` behind required idempotency. Class M; money self-audit per PR.
3. **Webhooks** — signing, retry, dedup, dashboard for failures.
4. **Sandbox keys** — routing a sandbox principal to the sandbox rail.
5. **Public docs + a merchant quickstart.**

Steps 1 and 2 are the tracker row. Steps 3–5 make it usable by someone who does not work here.

---

## 5 · What is deliberately NOT decided here

- **Who the acquirer is.** Class X, owner + counsel. `socket.psp-partners` stays open, and Hyperswitch stays killed (ADR #769).
- **Pricing, limits and rate tiers.** Commercial, not architectural.
- **PayFac / sub-merchant trees.** `pay.payfac` is its own row and its own law.

---

## 6 · Why an ADR rather than code

The row was about to be built from a wrong premise — "add OpenAPI to the schemas we have" — which would have produced a documented tRPC surface no merchant can call, with no auth story, no idempotency contract and no webhook signing. Those four are the product. The generator is an afternoon.
