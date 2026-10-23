# Decision: S2S body binding (L2-6) — how it ships without an outage

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** **Mechanism landed. `accept-both` is still the schema default, for local runs and tests only. The tRPC door is `require` by default since 2026-10-13. In production posture (`APP_ENV` anything but exactly `dev`/`test`) a service that holds `INTERNAL_SERVICE_SECRET` REFUSES TO BOOT unless `INTERNAL_SERVICE_BODY_BIND` is exactly `require` (`config.s2s_body_bind_not_required`), since the PR that added the section "Refusal in production posture" below.**
**Date:** 2026-07-30 · **Author:** Denon spine (Stream B) · **Board:** D12 · **Audit finding:** L2-6

---

## The hole

The service-to-service HMAC signed `` `${service}\n${timestamp}` `` and **not the request
body**. Within the 300-second skew window a captured signature was replayable against
**any body on any procedure of that service**.

That is not abstract. The S2S surfaces include the ones that move value:

| Surface                                   | Reached how                   | What a replay buys                                     |
| ----------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `svc-ledger` `/trpc/post`                 | `registerS2sHttp`, plain JSON | `ledger.post()` directly — any transaction, any amount |
| `svc-matching` `POST /markets/:id/orders` | `verifyServiceHeaders` guard  | an order the ledger never held funds for               |
| `svc-matching` `DELETE …/orders/:orderId` | same                          | cancel any resting order, releasing that user's hold   |

The original header comment was candid about the deferral and its reason — Fastify has
parsed and discarded the raw bytes by the time a handler or tRPC context runs. That
deferral was reasonable. It was also a replayable money instruction.

## What now happens

Two schemes, and exactly two.

|                | v1 (legacy)                | v2                                                                   |
| -------------- | -------------------------- | -------------------------------------------------------------------- |
| preimage       | `${service}\n${timestamp}` | `intafaced-s2s-v2\n` + length-prefixed `(service, ts, sha256(body))` |
| headers        | 3                          | 4 — adds `x-intafaced-service-body`                                  |
| body integrity | **none**                   | yes                                                                  |
| replay window  | 300s                       | 300s (unchanged)                                                     |

**The digest header's presence is the version marker.** No fourth "version" header
exists; one whose only content restates another header's presence is a thing to keep
in sync for no gain.

### Length-prefixing, and why not another newline

v1 used a newline so `('ab', 1)` and `('a', 11)` could not collide. With three fields
that reasoning thins out: `service` is entirely caller-controlled and may contain a
newline, so a bare `\n` join is injective only because of validation living elsewhere
— the timestamp must parse as an integer, the digest must be 64 hex characters. That
is an invariant held at a distance. One relaxed validator, or one added field, and the
framing silently stops being unambiguous.

So each field is `<byteLength>:<value>\n`. Injective on its own terms, whatever a field
contains. **Byte** length, not character length, so a multi-byte service name cannot
shift the frame. There is a test asserting distinct preimages across adversarial names
including embedded delimiters, a fake length prefix, and the precomposed-versus-combining
forms of `café` (which render identically and are 5 versus 6 bytes).

The `intafaced-s2s-v2` domain tag makes v1 and v2 preimages **disjoint by construction**.
That is what makes `accept-both` a migration window rather than a second hole: a captured
v1 signature can never be reinterpreted as v2, or the reverse. Both directions are tested.

### The digest covers bytes, not an object

`sha256` of the raw wire bytes, never of a re-serialised object — JSON key order and
whitespace are not canonical, so digesting `JSON.stringify(req.body)` would commit to a
different byte sequence than the one that arrived. Same rule `signPrincipalHeader`
already follows in `edge.ts`.

A caller with no body signs the digest of the **empty** body rather than omitting the
header. "There is no body" becomes a signed statement, so a body cannot be bolted onto
a bodyless call — which is a real route: `svc-matching`'s cancel is a `DELETE`.

## The mechanism, measured rather than assumed

Fastify 5.10.0, probed directly before any of this was written:

- `addContentTypeParser('application/json', { parseAs: 'buffer' }, …)` **overrides the
  built-in JSON parser with no prior `removeContentTypeParser`.** Worth checking —
  Fastify throws `FST_ERR_CTP_ALREADY_PRESENT` for duplicates in other cases, and the
  safe-looking remove-then-add would itself throw once anything else had replaced the
  parser.
- `parseAs: 'buffer'` hands over the wire bytes **verbatim** — key order, runs of
  whitespace, and multi-byte characters all survive.
- A `; charset=utf-8` parameter still routes to the `application/json` parser, so a
  caller adding one does not slip past.
- A bodyless request (`GET`, or `POST` with no content-type) **never invokes a
  content-type parser**, while an `onRequest` hook always runs.

That last asymmetry is why retention is modelled as three states, not two:

| state                            | meaning                       | under `require`                      |
| -------------------------------- | ----------------------------- | ------------------------------------ |
| `{ retained: true, bytes: <n> }` | the request carried a body    | verify the digest                    |
| `{ retained: true, bytes: <0> }` | no body, **and we know that** | verify against the empty digest      |
| `{ retained: false }`            | nobody kept the bytes         | **fail closed** — `body-unavailable` |

A fourth case, added 2026-10-13: `{ retained: false, unread: true }` — retention is
installed but the request announced a body that a foreign parser consumed. It is refused
in **both** modes (see "The tRPC adapter was not bound at all").

Collapsing the last two into `Buffer \| undefined` would let a service that forgot to
install retention accept every body while believing it had verified them.

Replacing the JSON parser means owning its error cases, so `FST_ERR_CTP_EMPTY_JSON_BODY`
and `FST_ERR_CTP_INVALID_JSON_BODY` are reproduced — status **and** code. A silent
400→500 change on the money path would be a poor trade for a security fix.

---

## The migration — this is the part that decides deployability

### It is incrementally deployable. No coordinated restart is required.

Two properties make that true:

1. **The default is `accept-both`.** A verifier running the new code accepts a v1
   caller running the old code. Nothing 401s at any point during the rollout.
2. **A v2 caller is safe to deploy before its verifier.** `accept-both` is also the
   default on the _old_ code path in the sense that matters: an old verifier ignores
   the unknown `x-intafaced-service-body` header entirely and validates the v1
   preimage — but a v2 caller signs the **v2** preimage, which an old verifier would
   reject.

**So caller and verifier ordering does matter, and only in one direction:** for any
pair, **the verifier must be running the new code before the caller starts sending v2.**

The safe order is therefore:

```
1. Deploy VERIFIERS first  (svc-ledger, svc-matching)  → accept-both, accepts v1 and v2
2. Deploy CALLERS second   (the ledger-clients)         → start signing v2
3. Watch the v1 warning go quiet
4. Flip verifiers to require
```

Because this PR changes verifiers and callers together, **step 1 and 2 collapse into one
rollout, and the order within it is the risk.** Deploying a v2 caller while its verifier
still runs old code produces 401s on that caller's money path.

> **Operator note, and this is the one thing to get right:** roll **svc-ledger and
> svc-matching before** svc-agents, svc-p2p and svc-token. If the deploy tooling cannot
> order them, deploy svc-ledger and svc-matching alone first, confirm health, then the
> rest. There is no version of this that breaks quietly — a wrong order is immediate,
> loud 401s on the affected caller, and the fix is to finish rolling the verifier.

### Rollback

`require` → `accept-both`. That cannot 401 anybody.

There is deliberately **no** `off` mode. It would look like a rollback lever and behave
like an outage: once callers sign v2 preimages, a verifier that refuses to read the
digest rejects every one of them.

### How an operator knows it is safe to flip to `require`

`svc-ledger` and `svc-matching` log a **warning on every accepted v1 call**, naming the
calling service:

```
s2s caller did not bind its request body (L2-6) — its signature is replayable;
redeploy it before setting INTERNAL_SERVICE_BODY_BIND=require
  { callingService: "svc-trade", scheme: "v1", bodyBind: "accept-both" }
```

**The signal is silence.** When that warning has not appeared for a full skew window
(300s) — realistically, over a period covering every caller's duty cycle including cron
paths like `svc-bank`'s standing orders and `svc-token`'s epoch mint — every caller is on
v2 and `INTERNAL_SERVICE_BODY_BIND=require` is safe.

Flip per service. `svc-ledger` and `svc-matching` are independent.

### Callers still on v1 — none (updated 2026-10-13)

When this decision was written, `svc-trade`, `svc-pay` and `svc-bank` still signed v1.
That table is retired. A full sweep of the repository (2026-10-13) found **zero non-test
callers of `serviceAuthHeaders` / `signServiceCall`**: every outbound S2S client in the
fleet — the ledger-clients, matching-client, affiliate accrue and payout, action-approval
consume, stake and rank-perks reads, edge authority reads, ops notification and authority
clients — signs v2 with `serviceAuthHeadersForBody(service, secret, payload)`, over the
same serialised string it sends. v1 survives only inside `service-auth.ts` itself and in
tests that assert it is refused.

Two consequences:

- **The tRPC door defaults to `require`.** `createEdgeContext` (every service that mounts
  `/trpc`) now verifies service callers under `require` unless a caller passes
  `bodyBindMode` explicitly. svc-identity pins `require` in code and ignores
  `INTERNAL_SERVICE_BODY_BIND`, because that knob exists for raw `/internal` routes and
  must not be able to downgrade `rank.awardXp`.
- **The flip on the remaining raw routes is now only a matter of watching the v1 warning
  go quiet**, as described above. No caller is known to block it.

### The tRPC adapter was not bound at all (fixed 2026-10-13)

The mechanism section above says retention keeps the bytes for every JSON request. On
`/trpc/*` it did not. The tRPC Fastify plugin registers its own scope and replaces the JSON
parser there with `parseAs: 'string'`, so `retainRawBody`'s parser never ran for tRPC
requests. The `onRequest` marker did run, and `rawBodyOf` answered "retained, **empty**".
In **both** modes that meant:

1. an honest v2 tRPC POST was verified against the empty digest and got `body-mismatch`;
2. an **empty-body** v2 signature, captured from any bodyless GET (svc-trade, support,
   agents and academy send them constantly), verified against an attacker-chosen body.
   `rank.awardXp` is a `serviceProcedure`, so a captured signature minted arbitrary XP for
   any user for 300 s — and XP drives rank, fee discounts, P2P limits and launchpad
   allocation.

Related: root routes whose body a non-retaining parser consumed (Fastify's built-in
`text/plain` parser) read as "empty, verified", and no service passed `bodyBindMode`, so
`createEdgeContext` was always `accept-both` whatever the env said.

What changed:

- `rawBodyOf` answers "empty" only for a request that did not announce a body. A request
  with a non-zero `content-length` or any `transfer-encoding` that no parser of ours kept is
  `{ retained: false, unread: true }`, and `verifyServiceCall` refuses that in **both**
  modes (`body-unavailable`). It is safe to refuse: an honest v2 caller signs its real
  bytes, which never matched the empty digest.
- `createEdgeContext` binds `req.body` when it is a string (the tRPC adapter's wire text,
  hashed as UTF-8, never re-serialised) or a Buffer, via `inboundRawBodyOf`. Services must
  pass the whole request to it (`edgeContext(req)`), not `{ headers, id }`, or `require`
  has no bytes to check.
- svc-identity, svc-notify, svc-token, svc-agents and svc-execution hand the whole request
  to their context factory. svc-ledger's `/trpc` routes are raw (`registerS2sHttp`,
  `retainRawBody`, `bodyBind: 'require'`) and were already correct.

### Known gap: the empty-body digest does not bind method or path

A bodyless call signs `sha256('')`, which is the same value for every bodyless request. A
captured empty-body signature is therefore valid, for the 300 s skew window, against
**every** bodyless S2S route and every tRPC `GET` query whose input travels in the URL — it
proves "svc-X called something with no body", not "svc-X called this". Body binding cannot
close that; binding the request target can. That is the deferred **v3** (method + path in
the length-prefixed preimage, see below). It is not implemented here, and until it is,
treat an empty-body `GET` signature as a short-lived bearer for any read-only S2S route.

### Residual risk while in `accept-both`, stated plainly

**`accept-both` buys a migration with no outage. It does not buy body integrity.**

A verifier in `accept-both` still accepts v1, so a captured **v1** call remains replayable
against any body for 300 seconds — exactly the hole L2-6 names. Domain separation means an
attacker cannot _downgrade_ a captured v2 call by stripping the digest header (tested),
but that does not help a caller that never sent one.

**The security property exists only under `require`.** Every caller is now v2, so nothing
stops the flip on the raw `/internal` routes (the tRPC door is already `require`); until
each verifier is flipped, a captured v1-style signature remains replayable there. The fix
is the flip.

### Refusal in production posture (since this change)

The flip to `require` on the raw `/internal` routes stopped being optional. `packages/config/src/production-posture.ts`
used to log `config.production_posture_warning` when a production-posture process held `INTERNAL_SERVICE_SECRET` and
`INTERNAL_SERVICE_BODY_BIND` was not `require`. It now throws `ProductionPostureError` with the stable code
`config.s2s_body_bind_not_required`, through `loadEnv` (every service) and through the entry points that call
`assertProductionPosture` directly (apps/admin, svc-notify's gateway, svc-ops' archive receiver). Why it could stop being a warning:

- The tRPC door has been `require` in code since 2026-10-13 and ignores the variable, so the variable only decides the
  raw `/internal` REST routes, where `accept-both` keeps a captured service signature replayable against any body for 300 s.
- No non-test caller signs v1 (the sweep above), so `require` refuses no honest caller.
- Every service that verifies on a raw route installs `retainRawBody` on the instance serving it, so `require` does not
  401 honest calls as `body-unavailable`. The 2026-10-14 survey found no raw route that `require` would break, and the launch services' suites (svc-ledger, svc-identity, svc-ops, svc-notify, svc-trade, svc-edge) pass identically with `INTERNAL_SERVICE_BODY_BIND=require` exported; the table is in the PR.

What it means for an operator:

- **Production posture** is `APP_ENV` anything other than exactly `dev` or `test` (or unset inside a `NODE_ENV=production`
  container). That includes `staging`: the staging deploy runs `docker-compose.apps.yml` with `APP_ENV=staging`.
- The host `.env` must say `INTERNAL_SERVICE_BODY_BIND=require` **before** the first deploy of this change. Compose still
  defaults the variable to `accept-both` (the pin tests hold that, and it keeps a local run working with no setup), so a host that forgets
  it now refuses to boot every service that receives `INTERNAL_SERVICE_SECRET`. Unset, `accept-both`, a typo and a
  different case all refuse; only the exact value `require` passes.
- A process that holds no `INTERNAL_SERVICE_SECRET` (svc-edge, svc-notify and apps/admin by design) is not affected.
- There is no flag to turn the refusal off. Rollback of a bad flip is a redeploy of the previous build, not a setting:
  `accept-both` is no longer a rollback lever in production posture.
- Dev and test (`APP_ENV=dev|test`, including the local stack and the CX-8 boot) keep `accept-both`; nothing on a laptop changes.

---

## Deliberately not in this change

- **Per-service keypairs.** Every service shares one secret, so any service can mint any
  other service's signature. Body binding does not help with that and neither does v2
  framing — it is a key-distribution and rotation problem, with a different design and a
  different blast radius. Bundling it here would mean doing both badly. **Own PR.**
- **Binding the method and path.** Body binding stops "any body"; it stops "any procedure"
  only narrowly, since two procedures can accept structurally similar bodies. (The
  route-crossing tests here pass because the _bodies_ differ, not because the path is
  bound.) Binding the request target is the completion and is cheap in code — but it
  breaks the fleet the first time anything between two services rewrites a path, so it
  needs a survey of the proxy and mount topology first. The length-prefixed framing exists
  so that adding a fourth field later is a clean `v3` and not a collision risk.

## Config

`INTERNAL_SERVICE_BODY_BIND` on `internalServiceEnvSchema`, so every S2S service picks it
up: `accept-both` (default, dev and test only) | `require` (mandatory in production posture, see above).
