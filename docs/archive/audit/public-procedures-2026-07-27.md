# Audit: every public procedure and unauthenticated route

**Date:** 2026-07-27 · **Scope:** all 11 services · **Trigger:** `svc-ledger` shipped `post: publicProcedure` — the procedure that moves money, with no authentication. This audit asks whether there are others, because the graph is mounting services now.

**Type:** docs-only. No service code changed, including where a bug was found. Every finding below is reported, not fixed.

---

## What the guards actually are

Read these two definitions first, because three findings follow directly from them.

`packages/contracts/src/trpc.ts:44`

```ts
/** Open to anyone. Use sparingly — most things need a principal. */
export const publicProcedure = t.procedure;
```

No middleware. Nothing.

`packages/contracts/src/trpc.ts:106`

```ts
export function publicJurisdictionProcedure(module: ModuleId, plane: Plane = 'fiat') {
  return t.procedure.use(({ ctx, next }) => {
    const decision = checkAccess({
      module,
      plane,
      region: ctx.region,
      kycTier: ctx.principal?.tier ?? 'none',
    });
    if (!decision.allowed) throw new TRPCError({ code: 'FORBIDDEN', message: decision.reason });
    return next({ ctx });
  });
}
```

Three properties that matter for every verdict in this document:

1. **It does not authenticate.** It runs the jurisdiction matrix with `kycTier: 'none'` for an anonymous caller. It is a geo gate, not an auth gate.
2. **On the protocol plane it is a no-op.** `checkAccess` (`packages/config/src/jurisdiction.ts:209`) short-circuits: `const permissionless = q.plane === 'protocol' && !mod.custodial;` → `allowed: true` unless the region carries `blocked: true`. No entry in `JURISDICTION_MATRIX` sets `blocked`. So all nine `publicJurisdictionProcedure('protocol', 'protocol')` calls in svc-protocol are, in code, identical to `publicProcedure`.
3. **`region` is caller-controlled and unsigned.** `packages/contracts/src/edge.ts:184` — `region: header('x-intafaced-region') ?? 'XX'`. The HMAC covers only the principal header. Nothing in the repo sets this header; per `docs/decisions/mount-boundary.md:94` **the edge does not exist yet**, so every request to every mounted service today is anonymous and every jurisdiction decision is made from a string the caller typed.

Consequence: on the fiat plane the matrix still bites (`ledger`/`trade`/`p2p` need `basic`, `pay`/`bank` need `full`, so an anonymous caller is denied) — but only until someone sends a region header, and only for modules whose `minTier` is above `none`. `identity`, `matching`, `blueprint`, `agents`, `chain`, `indexer`, `protocol` are all `minTier: 'none'` and pass anonymously in every region.

Also relevant throughout: `HTTP_HOST` defaults to `0.0.0.0` (`packages/config/src/env.ts:53`). "It's on a private network" is not a property of this code.

---

## Table — every `publicProcedure` / `publicJurisdictionProcedure`

27 across 10 services (`svc-matching` has no tRPC router at all).

| #   | Service       | File:line       | Procedure                | Type                                                 | What the resolver does                                                                                                                                                                                                 | Value / state / user data                               | Verdict                                                                               |
| --- | ------------- | --------------- | ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | svc-agents    | `router.ts:137` | `health`                 | `publicProcedure`                                    | Returns `{ok:true, service}`                                                                                                                                                                                           | none                                                    | SAFE-PUBLIC                                                                           |
| 2   | svc-bank      | `router.ts:440` | `health`                 | `publicProcedure`                                    | Returns `{ok:true, service}`                                                                                                                                                                                           | none                                                    | SAFE-PUBLIC                                                                           |
| 3   | svc-blueprint | `router.ts:53`  | `health`                 | `publicProcedure`                                    | Returns `{ok:true, service}`                                                                                                                                                                                           | none                                                    | SAFE-PUBLIC                                                                           |
| 4   | svc-identity  | `router.ts:51`  | `health`                 | `publicProcedure`                                    | Returns `{ok:true, service}`                                                                                                                                                                                           | none                                                    | SAFE-PUBLIC                                                                           |
| 5   | svc-identity  | `router.ts:56`  | `auth.register`          | `publicProcedure`                                    | `auth.register()` — inserts `users`, `profiles`, `rank_state`; publishes `userCreated`; awards 50 XP; issues a session                                                                                                 | **Mutation.** Creates a user and a session              | **NEEDS-REVIEW** — F5                                                                 |
| 6   | svc-identity  | `router.ts:78`  | `auth.login`             | `publicProcedure`                                    | `auth.login()` — constant-time password compare, TOTP if enrolled, issues session                                                                                                                                      | **Mutation.** Issues credentials                        | **NEEDS-REVIEW** — F6                                                                 |
| 7   | svc-identity  | `router.ts:90`  | `auth.refresh`           | `publicProcedure`                                    | `auth.refresh()` — rotates refresh token; reuse of a rotated token revokes every session for that user                                                                                                                 | **Mutation.** Bearer-authenticated by the token itself  | SAFE-PUBLIC (rate-limit gap, F6)                                                      |
| 8   | svc-identity  | `router.ts:102` | `auth.logout`            | `publicProcedure`                                    | `auth.logout()` — revokes the session for that refresh hash; returns `{ok:true}` unconditionally                                                                                                                       | **Mutation.** Bearer-authenticated; no existence oracle | SAFE-PUBLIC                                                                           |
| 9   | svc-ledger    | `router.ts:52`  | `health`                 | `publicProcedure`                                    | `{ok, service, postingEnabled}` from `ledger.status()`                                                                                                                                                                 | operational flag                                        | SAFE-PUBLIC                                                                           |
| 10  | svc-ledger    | `router.ts:57`  | `post`                   | `publicProcedure`                                    | **Posts a ledger transaction.** Parses `postRequestSchema`, calls `ledger.post()`                                                                                                                                      | **Moves value**                                         | **NEEDS-SERVICE-AUTH** — F2 (known; see F1 for why the announced fix is insufficient) |
| 11  | svc-p2p       | `router.ts:132` | `health`                 | `publicProcedure`                                    | Returns `{ok:true, service}`                                                                                                                                                                                           | none                                                    | SAFE-PUBLIC                                                                           |
| 12  | svc-p2p       | `router.ts:143` | `fiat.list`              | `publicProcedure`                                    | `enabledFiat()` from `packages/config` — static currency table                                                                                                                                                         | none                                                    | SAFE-PUBLIC                                                                           |
| 13  | svc-pay       | `router.ts:68`  | `health`                 | `publicProcedure`                                    | `{ok, service, rails: rails.ids()}` — logical rail ids                                                                                                                                                                 | rail id list                                            | SAFE-PUBLIC                                                                           |
| 14  | svc-protocol  | `router.ts:129` | `health`                 | `publicProcedure`                                    | `{ok, service, chainId, custodial:false, relayEnabled}`                                                                                                                                                                | public chain config                                     | SAFE-PUBLIC                                                                           |
| 15  | svc-protocol  | `router.ts:151` | `predictAddress`         | `publicJurisdictionProcedure('protocol','protocol')` | CREATE2 arithmetic over public constants + one `isDeployed` RPC call                                                                                                                                                   | none (public chain data)                                | SAFE-PUBLIC (RPC amplification, F9)                                                   |
| 16  | svc-protocol  | `router.ts:183` | `buildDeployment`        | `publicJurisdictionProcedure`                        | Returns unsigned calldata. Pure function                                                                                                                                                                               | none                                                    | SAFE-PUBLIC                                                                           |
| 17  | svc-protocol  | `router.ts:209` | `buildSessionGrant`      | `publicJurisdictionProcedure`                        | Validates a spec via `createSessionSpec` (which refuses withdrawal selectors), returns unsigned calldata                                                                                                               | none                                                    | SAFE-PUBLIC                                                                           |
| 18  | svc-protocol  | `router.ts:232` | `buildSessionRevoke`     | `publicJurisdictionProcedure`                        | Returns unsigned calldata                                                                                                                                                                                              | none                                                    | SAFE-PUBLIC                                                                           |
| 19  | svc-protocol  | `router.ts:241` | `buildRevokeAllSessions` | `publicJurisdictionProcedure`                        | Returns unsigned calldata for `bumpSessionEpoch`                                                                                                                                                                       | none                                                    | SAFE-PUBLIC                                                                           |
| 20  | svc-protocol  | `router.ts:250` | `sessionStatus`          | `publicJurisdictionProcedure`                        | Reads `chain.sessionOf` / `isSessionLive`                                                                                                                                                                              | public chain state                                      | SAFE-PUBLIC                                                                           |
| 21  | svc-protocol  | `router.ts:292` | `checkSessionCall`       | `publicJurisdictionProcedure`                        | Pure evaluation of a spec against a hypothetical call                                                                                                                                                                  | none                                                    | SAFE-PUBLIC                                                                           |
| 22  | svc-protocol  | `router.ts:324` | `sessionSpecHash`        | `publicJurisdictionProcedure`                        | Pure hash                                                                                                                                                                                                              | none                                                    | SAFE-PUBLIC                                                                           |
| 23  | svc-protocol  | `router.ts:346` | `relayUserOperation`     | `publicJurisdictionProcedure`                        | **Mutation.** `relay.submit()` → `verify()` (sender match, userOpHash re-derivation, `recoverAddress` against on-chain owner or a live session key, guarded-entry + specHash checks) then forwards to a public bundler | Moves nothing the user did not sign                     | SAFE-PUBLIC (verified — F9 for the residual)                                          |
| 24  | svc-token     | `router.ts:13`  | `health`                 | `publicProcedure`                                    | Returns `{ok:true, service}`                                                                                                                                                                                           | none                                                    | SAFE-PUBLIC                                                                           |
| 25  | svc-trade     | `router.ts:195` | `health`                 | `publicProcedure`                                    | Returns `{ok:true, service}`                                                                                                                                                                                           | none                                                    | SAFE-PUBLIC                                                                           |
| 26  | svc-trade     | `router.ts:201` | `markets.list`           | `publicProcedure`                                    | `trade.markets()` — listed market config (tick, lot, fee bps, status)                                                                                                                                                  | listing config, no user data                            | SAFE-PUBLIC                                                                           |
| 27  | svc-trade     | `router.ts:203` | `markets.get`            | `publicProcedure`                                    | Market by symbol, `NOT_FOUND` otherwise                                                                                                                                                                                | listing config                                          | SAFE-PUBLIC                                                                           |

**Note on `svc-p2p offers.list`:** the brief flagged it. It is `scopedProcedure('p2p:read', { module: 'p2p' })` (`router.ts:185`) — scope plus jurisdiction plus `minTier: 'basic'`. Not public. Same for `offers.get`, `trades.*`, `reputation.get`.

---

## Table — every raw Fastify route

33 routes. These bypass tRPC entirely: no context factory, no principal, no scope middleware. Ten of them are the real problem.

| #   | Service       | File:line             | Route                                       | What it does                                                                                                                                                                                        | Verdict                                       |
| --- | ------------- | --------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | svc-agents    | `index.ts:101`        | `GET /health`                               | `{ok, service}`                                                                                                                                                                                     | SAFE-PUBLIC                                   |
| 2   | svc-agents    | `index.ts:102`        | `GET /ready`                                | `{ready, meteringEnabled, tasks[]}` — logical task ids, no vendor names                                                                                                                             | SAFE-PUBLIC                                   |
| 3   | svc-bank      | `index.ts:41`         | `GET /health`                               | `{ok, service}`                                                                                                                                                                                     | SAFE-PUBLIC                                   |
| 4   | svc-bank      | `index.ts:42`         | `GET /ready`                                | `{ready, scheduledTransfers, interestAccrual}`                                                                                                                                                      | SAFE-PUBLIC                                   |
| 5   | svc-bank      | `index.ts:58`         | `POST /internal/jobs/run-due-transfers`     | Executes every due standing order — real ledger posts, other users' money                                                                                                                           | **NEEDS-SERVICE-AUTH** — F4                   |
| 6   | svc-bank      | `index.ts:65`         | `POST /internal/jobs/accrue-interest`       | Pays interest from every pool reserve                                                                                                                                                               | **NEEDS-SERVICE-AUTH** — F4                   |
| 7   | svc-blueprint | `index.ts:60`         | `GET /health`                               | `{ok, service}`                                                                                                                                                                                     | SAFE-PUBLIC                                   |
| 8   | svc-blueprint | `index.ts:67`         | `GET /ready`                                | `{ready, engine:{id, usable, mode}}` — logical engine id                                                                                                                                            | SAFE-PUBLIC                                   |
| 9   | svc-identity  | `index.ts:56`         | `GET /health`                               | `{ok, service}`                                                                                                                                                                                     | SAFE-PUBLIC                                   |
| 10  | svc-identity  | `index.ts:57`         | `GET /ready`                                | `{ready, argon2}`                                                                                                                                                                                   | SAFE-PUBLIC                                   |
| 11  | svc-identity  | `index.ts:63`         | `GET /internal/rank/:userId/perks`          | Any user's rank perks by id                                                                                                                                                                         | **NEEDS-SERVICE-AUTH** — F7                   |
| 12  | svc-ledger    | `index.ts:41`         | `GET /health`                               | `{ok, service, ...ledger.status()}` — spreads `frozenReason`                                                                                                                                        | **NEEDS-REVIEW** — F8                         |
| 13  | svc-ledger    | `index.ts:43`         | `GET /ready`                                | 503 body carries `reason: status.frozenReason`                                                                                                                                                      | **NEEDS-REVIEW** — F8                         |
| 14  | svc-ledger    | `s2s-http.ts:82`      | `POST /trpc/post`                           | **Posts a ledger transaction.** No auth                                                                                                                                                             | **NEEDS-SERVICE-AUTH** — F1                   |
| 15  | svc-ledger    | `s2s-http.ts:91`      | `POST /trpc/balance`                        | Any account's balance. No auth                                                                                                                                                                      | **NEEDS-SERVICE-AUTH** — F3                   |
| 16  | svc-ledger    | `s2s-http.ts:100`     | `POST /trpc/balances`                       | Every balance for any owner. No auth, **no ownership check**                                                                                                                                        | **NEEDS-SERVICE-AUTH** — F3                   |
| 17  | svc-matching  | `index.ts:43`         | `GET /health`                               | `{ok, service, enabled, markets, journalRecords}`                                                                                                                                                   | SAFE-PUBLIC                                   |
| 18  | svc-matching  | `index.ts:57`         | `GET /ready`                                | 503 when engine disabled                                                                                                                                                                            | SAFE-PUBLIC                                   |
| 19  | svc-matching  | `router.ts:105`       | `POST /markets/:marketId/orders`            | Submits an order to the engine. No auth, no ownership, `accountId` is a caller-supplied string                                                                                                      | **NEEDS-SERVICE-AUTH** — F2                   |
| 20  | svc-matching  | `router.ts:118`       | `DELETE /markets/:marketId/orders/:orderId` | Cancels a live order by id. No auth, **no ownership check**                                                                                                                                         | **NEEDS-SERVICE-AUTH** — F2                   |
| 21  | svc-matching  | `router.ts:130`       | `GET /markets/:marketId/depth`              | Price-level aggregate — `[price, total]` pairs, no account ids                                                                                                                                      | SAFE-PUBLIC                                   |
| 22  | svc-matching  | `router.ts:137`       | `GET /markets`                              | Market id list                                                                                                                                                                                      | SAFE-PUBLIC                                   |
| 23  | svc-p2p       | `index.ts:63`         | `GET /health`                               | `{ok, service}`                                                                                                                                                                                     | SAFE-PUBLIC                                   |
| 24  | svc-p2p       | `index.ts:64`         | `GET /ready`                                | `{ready, tradingEnabled}`                                                                                                                                                                           | SAFE-PUBLIC                                   |
| 25  | svc-p2p       | `index.ts:71`         | `GET /internal/escrow-integrity`            | Escrow-vs-ledger drift per (seller, asset)                                                                                                                                                          | **NEEDS-SERVICE-AUTH** — F7                   |
| 26  | svc-p2p       | `index.ts:77`         | `GET /internal/reputation/:userId`          | Any user's P2P reputation by id                                                                                                                                                                     | **NEEDS-SERVICE-AUTH** — F7                   |
| 27  | svc-pay       | `index.ts:72`         | `GET /health`                               | `{ok, service}`                                                                                                                                                                                     | SAFE-PUBLIC                                   |
| 28  | svc-pay       | `index.ts:73`         | `GET /ready`                                | `{ready, rails}`                                                                                                                                                                                    | SAFE-PUBLIC                                   |
| 29  | svc-pay       | `index.ts:94`         | `POST /webhooks/:railId`                    | Rail webhook. Raw body preserved; `adapter.verifyWebhook` does HMAC + timestamp tolerance and returns `null` on failure; parse happens only after verify; one uninformative 401 for every rejection | SAFE-PUBLIC (authenticated by rail signature) |
| 30  | svc-protocol  | `index.ts:80`         | `GET /health`                               | `{ok, service, chainId, custodial:false, relayEnabled}`                                                                                                                                             | SAFE-PUBLIC                                   |
| 31  | svc-protocol  | `index.ts:92`         | `GET /ready`                                | 503 + chain error message when RPC unreachable                                                                                                                                                      | SAFE-PUBLIC                                   |
| 32  | svc-token     | `index.ts:52` / `:53` | `GET /health`, `GET /ready`                 | `{ok, service}` / `{ready, emissionsEnabled}`                                                                                                                                                       | SAFE-PUBLIC                                   |
| 33  | svc-token     | `index.ts:55`         | `GET /internal/stake/:userId`               | Any user's staked amount, tier and fee discount                                                                                                                                                     | **NEEDS-SERVICE-AUTH** — F7                   |

---

# Findings

Worst first. Only NEEDS-\* entries appear here.

---

## F1 — svc-ledger's mounted money surface has no auth, and the announced fix does not touch it

**`services/svc-ledger/src/s2s-http.ts:82` · `POST /trpc/post` · NEEDS-SERVICE-AUTH**

This is the most important finding in the document, and it is not the one that was found.

`services/svc-ledger/src/index.ts` never registers `fastifyTRPCPlugin`. It has no `createEdgeContext` call. The only thing it mounts is:

```ts
registerS2sHttp(app, ledger); // index.ts:49
```

which is:

```ts
export function registerS2sHttp(app: FastifyInstance, ledger: LedgerService): void {
  app.post('/trpc/post', async (req, reply) => {
    try {
      return await handleS2sPost(ledger, req.body);
    } catch (err) {
      const { status, body } = httpError(err);
      return reply.code(status).send(body);
    }
  });
```

`handleS2sPost` (`s2s-http.ts:41`) parses `postRequestSchema` and calls `ledger.post()`. There is no principal, no scope check, no shared secret, no allowlist, no `preHandler` — nothing between `req.body` and the ledger.

**The concrete attack.** Identical to the known one, at a path that is actually served:

```
POST http://<svc-ledger>:<port>/trpc/post
Content-Type: application/json

{ "idempotencyKey": "x-0001", "module": "ledger", "reason": "deposit",
  "entries": [ { "account": {...railBoundary...}, "direction": "credit", "amount": "10000000" },
               { "account": {"ownerType":"user","ownerId":"<attacker uuid>","assetId":"USDT","kind":"available"},
                 "direction": "debit",  "amount": "10000000" } ] }
```

Balanced, so every invariant holds; `railBoundary` is a treasury account permitted to run negative, so nothing rejects it. The attacker now has a balance they can trade, escrow, or withdraw. `HTTP_HOST` is `0.0.0.0`.

**Why this is worse than the known issue.** The fix in flight targets `post: publicProcedure` in `services/svc-ledger/src/router.ts:57`. That router is constructed and exported for its type, but **it is not mounted**. Scoping it changes the type signature and nothing about what is reachable on the port. If the fix ships and the raw handler is left as-is, the hole is closed on paper and open in production.

The service's own header comment states the intent:

> `index.ts:13` — _"Graph W1-C: S2S money plane via registerS2sHttp (plain /trpc/\* for clients). Network policy must keep these off the public internet until holds + service auth land for real deploy."_

That is a comment, not a control — the same category of thing `svc-identity`'s `awardXp` was corrected for (`services/svc-identity/src/router.ts:165`: _"This was `publicProcedure` with only a comment saying 'service-to-service', which is a comment, not a control"_). The same reasoning applies here with money instead of XP.

---

## F2 — svc-matching accepts and cancels orders from anyone, and svc-trade settles the resulting events

**`services/svc-matching/src/router.ts:105` and `:118` · NEEDS-SERVICE-AUTH**

Neither route has a principal, a scope, or an ownership check. `registerRoutes` attaches them with no `preHandler`, and `index.ts` installs no global hook.

```ts
app.delete('/markets/:marketId/orders/:orderId', async (req, reply) => {
  const { marketId, orderId } = req.params as { marketId: string; orderId: string };
  const result = await engine.cancel(marketId, orderId);
```

Two ids in, a cancellation out. Nothing asks whose order it is.

**Concrete attack A — cancel other people's resting orders.** `DELETE /markets/{marketId}/orders/{orderId}`. The engine cancels it and publishes `orderCancelled`. `services/svc-trade/src/events.ts:58` consumes that subject and calls `trade.releaseOnCancelEvent(payload.orderId)` → `finalize(orderId, 'cancelled')`, which releases the hold and marks the order cancelled in svc-trade's own tables. The victim's order is gone from the book and from their account, and every record agrees it was a legitimate cancel. Repeat across a book to thin one side, then trade into the gap. Market ids come from `GET /markets`; order ids are uuids, so this needs an id the attacker has seen — trivially satisfied for their own counterparties, and see attack C.

**Concrete attack B — submit orders that skipped every risk control.** `POST /markets/{marketId}/orders` with a body containing `accountId` as an arbitrary string. `svc-trade` is where risk → hold → engine lives (`router.ts:218`, `scopedProcedure('trade:write', { module: 'trade' })`); the engine performs no funding check, no tier check, no jurisdiction check, and does not see the `trade.spot` kill-switch (`TRADE_SPOT_ENABLED` gates svc-trade, not svc-matching). Going straight to the engine means an order rests and matches with no hold behind it.

The settlement side does not re-derive the numbers. `services/svc-trade/src/spot/trade-service.ts:709`:

```ts
async settleFillEvent(input: { marketId; makerOrderId; takerOrderId; price: string; qty: string; sequence }) {
  ...
  await this.settleFill(market, {
    ...
    price: input.price,   // straight from the event
    qty: input.qty,       // straight from the event
  });
```

`price` and `qty` are taken from the bus payload and settled, not recomputed from the stored order. The service does have a `trade.hold_uncovered` error code, so an over-fill is detected rather than silently paid — but detection is an operator alarm after a money path already ran, which is the wrong end.

**Concrete attack C — counterparty account ids.** The submit response includes them. `presentFill` (`router.ts:52`) returns `makerAccountId` and `takerAccountId`; `presentResting` (`router.ts:63`) returns `accountId`. Submit a minimum-size crossing order and the response names the account on the other side. The aggregated `depth` endpoint deliberately does not leak this (`engine/book.ts:143` folds to `[price, total]`) — the submit path undoes that.

`docs/decisions/mount-boundary.md:16` lists matching as "plain HTTP, no `/trpc`". That decision is about which transport it speaks. It is not a decision that the transport needs no caller authentication, and nothing in this service supplies one.

---

## F3 — svc-ledger's balance reads have no auth and no ownership check

**`services/svc-ledger/src/s2s-http.ts:91` and `:100` · NEEDS-SERVICE-AUTH**

`POST /trpc/balances` with `{"ownerType":"user","ownerId":"<any uuid>"}` returns every balance that user holds, in every asset and every kind — `available`, `escrow`, `hold`, `stake`.

The tRPC twin of this procedure has the check that the raw one is missing. `services/svc-ledger/src/router.ts:95`:

```ts
balances: scopedProcedure('ledger:read')
  ...
  .query(async ({ ctx, input }) => {
    // A principal may only read its own balances, whatever its scopes say.
    if (input.ownerType === 'user' && ctx.principal.userId !== input.ownerId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'This account belongs to another user' });
    }
```

`handleS2sBalances` (`s2s-http.ts:70`) has no equivalent. Two doors to the same data; the one that is mounted is the one with no lock. `ownerType: 'treasury'` and `'house'` are also accepted, so the platform's own float is readable by anyone who can reach the port.

---

## F4 — svc-bank's operator jobs are reachable without the operator scope

**`services/svc-bank/src/index.ts:58` and `:65` · NEEDS-SERVICE-AUTH**

Both jobs exist twice: once behind `scopedProcedure('admin:treasury')` in the router (`router.ts:390`, `:404`), and once as a bare `app.post` with only a feature-flag check.

```ts
app.post('/internal/jobs/run-due-transfers', async (_req, reply) => {
  if (!env.SCHEDULED_TRANSFERS_ENABLED) return reply.code(503).send({ ... });
  return withSpan('bank.job.runDueTransfers', async () => bank.transfers.runDueTransfers({ limit: env.TRANSFER_BATCH_SIZE }));
});
```

The router's own comment states why the scope is there (`router.ts:385`): _"The jobs live behind `admin:treasury` — a scope §4.1 marks interactive-only, so it can never be held by a long-lived API key."_ The HTTP route requires neither the scope nor the MFA that scope implies.

**What an anonymous caller actually gets.** Both jobs are properly idempotent, and the audit checked this rather than assuming it — `accrueInner` claims the day with `INSERT ... ON CONFLICT (pool_id, accrual_date) DO NOTHING` (`earn/earn-service.ts:428`), and `driveSchedule` derives what has fired from `MAX(occurrence)` in `bank.transfer_executions` rather than a counter (`transfers/transfer-service.ts:265`). So this is **not** an interest-minting or double-payment bug, and it should not be written up as one.

What it is:

- **Timing control over other people's money.** `runDueTransfers` selects `WHERE status = 'active' AND next_run_at <= now()`. Between the moment a schedule becomes due and the moment the operator's cron fires, an anonymous caller decides when the transfer executes. An attacker watching a victim's spaces can fire the outflow at a chosen instant — for example immediately before the victim's balance is needed to cover a hold elsewhere.
- **Unauthenticated request amplification into svc-ledger.** One HTTP request causes a table scan plus up to `TRANSFER_BATCH_SIZE` ledger posts. `accrue-interest` iterates every pool and every position. No rate limit exists anywhere in the repo.
- **The control that was designed is not the control that is enforced.** MFA-gated operator authority in one door, nothing in the other.

---

## F5 — svc-identity registration is an account-enumeration oracle, and is unmetered

**`services/svc-identity/src/router.ts:56` · `auth.register` · NEEDS-REVIEW**

Registration must be public. Two things about this implementation are not consequences of that.

**Enumeration.** `auth-service.ts:68`:

```ts
const clash =
  await tx`SELECT handle, email FROM identity.users WHERE handle = ${input.handle} OR email = ${input.email}`;
for (const row of clash) {
  if (row.handle.toLowerCase() === input.handle.toLowerCase())
    throw new AuthError('That handle is taken', 'auth.handle_taken');
  throw new AuthError('An account with that email already exists', 'auth.email_taken');
}
```

Both map to `CONFLICT` (`router.ts:31-34`) but with distinct `intafacedCode`s (`auth.handle_taken` vs `auth.email_taken`) and distinct messages, which the error formatter surfaces deliberately (`packages/contracts/src/trpc.ts:33`). Submit a registration with a throwaway handle and a target email: `auth.email_taken` means that address has an account here, `auth.handle_taken` cannot occur, and success means it does not. That is a clean yes/no oracle over any email address, from an unauthenticated endpoint, with no rate limit.

Worth contrasting with `login`, which gets the same problem right — `auth-service.ts:123` hashes against `dummyPasswordHash()` when no user exists specifically so an unknown account costs the same time as a wrong password. The care taken on the login path was not carried to the registration path.

**No metering.** `grep -ri 'rate.?limit|@fastify/rate-limit|lockout|captcha'` across the repo returns matches only in `packages/i18n`, `packages/exchange-contract`, `INTAFACED_DEFINITIVE_BUILD.md`, and `docs/decisions/mount-boundary.md:95` (which records the gap: _"No rate limiting, no request size cap on mounted services"_). There is no implementation. `REGISTRATION_OPEN` is the only brake, and it is binary. Each registration runs an argon2id hash, three inserts, a NATS publish and an XP award, so this is also the cheapest CPU-exhaustion request in the system.

**Bug, unrelated to auth, found on this path.** `router.ts:71`:

```ts
const session = await auth.register({ ...input, ip: ctx.requestId });
```

`ctx.requestId` is the Fastify request id (`edge.ts:185` — `requestId: String(req.id ?? '')`), not an IP. It is written to `identity.sessions.ip` (`auth-service.ts:157`). Every session row records a value that is unique per request and identifies nothing, so the `ip` column is useless for the two things it exists for: session forensics and any future per-IP throttle. `login`, `refresh` and `logout` pass no `ip` at all, so those rows are `null`. Reported, not fixed.

---

## F6 — svc-identity login has no attempt limiting

**`services/svc-identity/src/router.ts:78` · `auth.login` · NEEDS-REVIEW**

The cryptography here is careful — constant-time comparison against a real dummy hash, identical `UNAUTHORIZED`/`"Invalid credentials"` for both a wrong password and a wrong TOTP code (`router.ts:22-25`), opportunistic rehash. None of that limits attempts.

**Concrete attack.** Unlimited `auth.login` calls against one account: no lockout, no delay, no counter, no captcha. Combined with F5 the sequence is: enumerate valid emails through `register`, then credential-stuff each one through `login` at whatever rate the box sustains. TOTP is only a barrier for accounts that enrolled it, and `totp.enrol` is `protectedProcedure` — a new account has no second factor. `auth.refresh` shares the gap: it is a bearer check with correct reuse-detection (`auth-service.ts:199`), but an attacker can guess refresh tokens as fast as they like (48 bytes of entropy makes that infeasible in practice, so the exposure here is load, not compromise).

`register`, `login`, `refresh` and `logout` are all correctly public. The finding is the missing rate limit, not the missing auth.

---

## F7 — five `/internal/*` routes serve per-user data with no caller check

**NEEDS-SERVICE-AUTH**

Each of these has a tRPC counterpart carrying a scope. The HTTP version carries nothing. The prefix `/internal/` is a naming convention; Fastify does not treat it specially and nothing in these services filters on path.

| Route                              | File:line                      | Returns                                                | Scope on the tRPC twin                                                                                                              |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /internal/stake/:userId`      | `svc-token/src/index.ts:55`    | `{staked, tier, feeDiscountBps}` — **a balance**       | `stakeOf`: `scopedProcedure('token:read')` (`svc-token/src/router.ts:17`)                                                           |
| `GET /internal/rank/:userId/perks` | `svc-identity/src/index.ts:63` | Rank perks — fee discounts, limits                     | `rank.perks`: `scopedProcedure('identity:read')` (`svc-identity/src/router.ts:156`)                                                 |
| `GET /internal/reputation/:userId` | `svc-p2p/src/index.ts:77`      | Trade counts, disputes, disputes lost, completion rate | `reputation.get`: `scopedProcedure('p2p:read', { module: 'p2p' })` — scope **and** `minTier: 'basic'` (`svc-p2p/src/router.ts:356`) |
| `GET /internal/escrow-integrity`   | `svc-p2p/src/index.ts:71`      | Escrow-vs-ledger drift per (seller, asset)             | none — operator surface with no tRPC equivalent                                                                                     |

**Concrete attack.** Walk user uuids (obtainable from `sessionOutput.userId`, from `offerOutput.makerId`, from `tradeOutput.sellerId`/`buyerId`) and harvest, per user, their staked balance, their fee tier, and their full P2P dispute history. Cross-referenced, that is a ranked target list: who holds the most, who has lost disputes, who trades at volume. All of it is behind a scope on the tRPC path and behind nothing here.

`svc-identity/src/index.ts:61` states the assumption explicitly: _"Not edge-principal: internal network only; no scopes to elevate."_ `HTTP_HOST` defaults to `0.0.0.0` and no network policy is asserted anywhere in the repo, so "internal network only" is a deployment intention. The second clause — "no scopes to elevate" — is true and is why this is an F7 and not an F1: these leak data, they do not move value.

`escrow-integrity` is a different shape: it is the operator alarm for Doctrine §0.6 drift. Exposing it tells an attacker when this service's view of escrow and the ledger's view disagree, which is precisely the window in which an escrow bug is exploitable.

---

## F8 — svc-ledger's health and readiness endpoints leak the freeze reason

**`services/svc-ledger/src/index.ts:41` and `:43` · NEEDS-REVIEW**

```ts
app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME, ...ledger.status() }));

app.get('/ready', async (_req, reply) => {
  const status = ledger.status();
  if (!status.postingEnabled) return reply.code(503).send({ ready: false, reason: status.frozenReason });
```

The spread on `/health` publishes every field of `LedgerStatus`, `frozenReason` included; `/ready` publishes it explicitly in the 503 body. `frozenReason` is free text supplied by an operator at `ledger.freeze(input.reason)` (`router.ts:134`, `admin:treasury`) or written by the reconciliation failure path (`index.ts:57`).

**Concrete attack.** Poll `/health`. A reason string such as `"reconciliation failed: USDT unbalanced by 41.2"` or `"suspected exploit in escrow release, pausing"` tells an unauthenticated observer that the ledger is frozen, why, and which asset — an incident-detection feed, published before any operator has announced anything. It also gives a would-be attacker confirmation of whether their own activity has been noticed.

Every other service's `/health` returns `{ok, service}` and nothing more. This one is the outlier. The other services' `/ready` endpoints leak only feature flags, which is the intended purpose of a readiness probe; svc-protocol's `/ready` returns the raw chain-client error message (`index.ts:97`), which is upstream infrastructure detail rather than platform state — noted, not escalated.

---

## F9 — svc-protocol is correct; the residual is unmetered RPC amplification

**`services/svc-protocol/src/router.ts:151`, `:346` · NEEDS-REVIEW (low)**

**The README's argument holds, and it was checked rather than accepted.** `MODULES.protocol` is `custodial: false`, `planes: ['protocol']` (`packages/config/src/modules.ts:86`), so `checkAccess` returns `allowed.permissionless` and there is genuinely nothing to gate. Seven of the nine `publicJurisdictionProcedure` calls are pure functions over public constants or reads of public chain state. `index.ts:108` re-asserts §22 at boot and refuses to start if the module ever stops being permissionless. `packages/auth` really does have no `protocol:write` scope.

`relayUserOperation` was the one to check properly, and it is sound. `relay.submit` → `relay.verify` (`session/relay.ts:147`):

- `toChecksum(userOp.sender) !== toChecksum(account)` → refuse (`:149`);
- the userOpHash is **re-derived** from the operation, entry point and chain id rather than trusted (`:153`);
- owner mode: `recoverAddress` over the EIP-191 digest, compared against `chain.ownerOf(account)` read from the chain (`:164-170`);
- session mode: the recovered signer must hold a session on-chain, that session must be live, the calldata must decode to `executeWithSession`, the named key must equal the recovered signer, and the presented spec hash must equal the granted one (`:178-198`).

There is no signing key in the service (`index.ts:22` — _"it loads no private key"_). An anonymous caller can only relay an operation the account's own owner or a live session key already signed, and could equally submit it to any public bundler themselves. **SAFE-PUBLIC, verified.**

The residual, stated at its real size:

- **Unmetered outbound work.** `verify` calls `chain.ownerOf` / `sessionOf` / `isSessionLive` **before** any expensive rejection, and `predictAddress` calls `chain.isDeployed` on every request. Each is an RPC call to `PROTOCOL_RPC_URL`. An anonymous caller sends `relayUserOperation` with arbitrary `account` addresses and a junk signature — every one costs an upstream RPC call before it is refused. Against a metered RPC provider that is a billing-drain and quota-exhaustion vector, and exhausting the quota takes `/ready` to 503 (`index.ts:92`) and the service out of rotation. Not a doctrine violation and not a custody risk; a rate limit, not a scope, is the fix.
- **The jurisdiction guard is decorative here.** As established at the top: `publicJurisdictionProcedure('protocol', 'protocol')` cannot deny anything, because `checkAccess` short-circuits before the region lookup for anything but `entry.blocked`, and no entry sets it. This is _intended_ — §22 is the whole point — but it means the guard provides no defence-in-depth if `MODULES.protocol.custodial` is ever flipped. The boot assertion at `index.ts:108` is what actually protects that invariant, and it is the right control.

---

## Adjacent findings — not public procedures, reported because they were found

Out of scope for this audit's question but in scope for "report bugs in the doc". All are authenticated-caller IDORs: a scope is checked, ownership is not.

| File:line                                   | Procedure                                          | Missing check                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `svc-bank/src/router.ts:248`                | `transfers.cancel`                                 | `scopedProcedure('bank:write')` with no `assertSelf`. Any authenticated user cancels any user's standing order by `scheduleId`. Neighbouring mutations (`transfers.create:165`, `transfers.schedule:191`, `earn.withdraw:311`, `spaces.archive:140`) all call `assertSelf`; this one does not. |
| `svc-bank/src/router.ts:233`                | `transfers.executions`                             | `scopedProcedure('bank:read')` with no ownership check on `scheduleId` — returns another user's transfer history, amounts included.                                                                                                                                                            |
| `svc-pay/src/router.ts:196`, `:202`, `:246` | `payment.get`, `payment.history`, `settlement.get` | `pay:read` with no merchant-ownership check. Any merchant reads any other merchant's payments, event history and settlements by id.                                                                                                                                                            |

`svc-trade` and `svc-agents` do this correctly and are worth copying: `trade.getOrder` filters on `order.userId !== principal.userId` (`spot/trade-service.ts:762`), and `ownedSession` (`svc-agents/src/router.ts:126`) returns the same `NOT_FOUND` for "does not exist" and "is not yours" so the endpoint is not an id oracle.

---

# Mount checklist

Derived from what this audit actually found, not from first principles. Every question below is one that a real finding above would have caught.

**Before mounting any service:**

1. **Is the router you audited the surface that is actually served?** F1. `svc-ledger` has a fully-scoped tRPC router that `index.ts` never registers, and a raw handler that is registered and has no auth. Open `index.ts`, list every `app.get`/`app.post`/`app.delete`/`register(...)` call, and audit _that_ list. A `publicProcedure` in an unmounted router is a typo; an unauthenticated `app.post` in a mounted one is an incident.

2. **Does every raw Fastify route have the same guard as its tRPC twin — or a documented reason it does not?** F3, F4, F7. Five services expose the same data or the same job twice, once behind a scope and once behind nothing. Diff the two lists explicitly. If a route has no twin (`escrow-integrity`), say who is allowed to call it and what enforces that.

3. **Does anything you are about to expose reach a ledger post?** F1, F2, F4. Trace it: procedure → service method → `ledger-client`. If the trace terminates in a post, the caller needs service auth, not a comment. Include indirect paths — svc-matching does not import `ledger-client` at all, and still causes ledger posts via `intafaced.matching.*` and svc-trade's consumer.

4. **Does this service consume events whose producer is unauthenticated?** F2. Bus payloads inherit the trust of whoever can make the producer emit. `settleFillEvent` settles `price` and `qty` from the event without re-deriving them from its own order record. If the producer's port is open, the consumer's inputs are attacker-controlled.

5. **Does `/health` return more than `{ok, service}`?** F8. Every field you spread into a health response is published to anyone who can reach the port. `...ledger.status()` published `frozenReason`. Enumerate the fields; do not spread an object.

6. **For every `publicJurisdictionProcedure`: which plane and which module?** On `plane: 'protocol'` with a non-custodial module it denies nothing at all — verify that is what you meant. On `plane: 'fiat'` it denies anonymous callers only where `minTier > 'none'`, so check the module's row in `DEFAULT_MODULE_RULES` (`identity`, `matching`, `blueprint`, `agents`, `core-ops` are all `none`). And note that it is a **geo** gate: it never establishes who the caller is.

7. **Does anything authorise on `ctx.region`?** It arrives in an unsigned, caller-supplied `x-intafaced-region` header (`edge.ts:184`) and the HMAC does not cover it. Until the edge exists and strips inbound copies of that header, treat every region-derived decision as caller-chosen.

8. **Is there any per-caller limit on this surface?** F5, F6, F9. There is no rate limiting anywhere in this repo. For an unauthenticated mutation — registration, login, relay, a job trigger — the absence of a limit is the whole control surface. Decide it before mounting, not after.

9. **Does any error distinguish "exists" from "does not exist"?** F5. `auth.handle_taken` vs `auth.email_taken` is an enumeration oracle. `ownedSession` in svc-agents is the pattern to copy: same error either way.

10. **Does every mutation that names an id verify the caller owns it?** Adjacent findings. A scope answers "may this principal do this kind of thing"; it never answers "may they do it to _this_ row".

---

## Honest summary

**The known `svc-ledger` `post: publicProcedure` is not the only unauthenticated money path — and the fix in flight does not close the one that is actually mounted.** F1 is the same class of bug at `s2s-http.ts:82`, on the only surface svc-ledger serves. F2 is a second, independent money path through svc-matching. F3 exposes every balance in the system, including treasury.

Of the 27 tRPC public procedures, exactly one moves value (`svc-ledger.post`, known) and it is not mounted; the other 26 are health checks, static config, genuine public reads, correctly-public auth endpoints, and svc-protocol's permissionless plane. **svc-protocol's README argument was checked procedure by procedure and it holds, `relayUserOperation` included.** The tRPC layer is, on the whole, in good shape.

The raw Fastify layer is not. Ten of 33 routes need a control they do not have, and nine of those ten have a properly-guarded tRPC twin sitting next to them — the guard was written, then bypassed by a second door. That is the pattern worth taking away: this codebase's authorisation is careful where it is declared on a procedure and absent where a route was added by hand.
