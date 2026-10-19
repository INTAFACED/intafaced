# Decision: mount boundary — who self-mounts `/trpc`

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** **Stamped — Nitro's default accepted, with one binding precondition.**
**Date:** 2026-07-27 · **Stamped by:** Denon · **Scope:** unblocks the graph's mechanical mounts.

---

## The stamp

Nitro's proposed default, accepted as written:

| Service                                    | Mount                  |
| ------------------------------------------ | ---------------------- |
| Core (identity, ledger, token) + **trade** | **self-mount `/trpc`** |
| **pay**                                    | self-mount, edge-only  |
| **matching**                               | plain HTTP, no `/trpc` |
| p2p, bank, blueprint, agents, protocol     | self-mount `/trpc`     |

**No public money env until purpose-keyed holds (P0-3) land.** Unchanged.

### AMENDED 2026-07-28 — "gateway only" was ambiguous, and the ambiguity cost real work

That row originally read **"gateway only (§9)"**. It meant _not publicly exposed_, which is now satisfied by svc-edge being the only public listener. It did **not** mean "does not serve `/trpc`".

An agent building the mounts read it as a prohibition and correctly stopped rather than overturn a stamped decision on the one service that owns a public webhook. That was the right call on the information available — the wording was mine and it was wrong.

The consequence of leaving it: svc-edge routes `/api/pay` to svc-pay, so an unmounted svc-pay means the edge forwards to a service with nothing behind it. Every mounted service is reached the same way — it serves `/trpc`, and only the edge is public. `pay` is not different.

**Lesson for the next stamp:** state the property (_"not publicly exposed"_), not the mechanism (_"gateway only"_). A reader cannot tell which mechanisms a property forbids.

`svc-agents` is the reference implementation. Copy its `index.ts`.

---

## The precondition — read this before mounting anything

**A service may self-mount `/trpc` only once it verifies the edge's signature over the principal header.** `packages/contracts/src/edge.ts` → `createEdgeContext`.

This is not a style preference, and it is why the stamp took longer than a yes.

### What I found

Every authorisation decision in the OS reads `ctx.principal` — `requireScope`, `requireTier`, the MFA gate on `INTERACTIVE_ONLY_SCOPES`, the jurisdiction matrix. None of them re-derive it.

`svc-agents` — the only service mounted on `main` today, and the template the graph was about to copy eleven times — built that principal like this:

```ts
principal: (req.headers['x-intafaced-principal']
  ? JSON.parse(String(req.headers['x-intafaced-principal']))
  : null) as never,
```

The header is caller-supplied. So any caller that can reach the port could assert **any user id, any scope set, any KYC tier, and `mfa: true`** — and every guard downstream would agree with them.

That is not "a `publicProcedure` is exposed." It is **every procedure at once**, including `trade:withdraw` and `admin:treasury`, whose MFA requirement is satisfied by the attacker writing `"mfa": true`.

Two details make it worse rather than theoretical:

- **`HTTP_HOST` defaults to `0.0.0.0`** (`packages/config/src/env.ts:53`). The default binding is every interface, so "it's on a private network" is a deployment fact nobody has established yet, not a property of the code.
- **`as never`** did not merely skip validation — it instructed the compiler to stop asking. Every downstream read of `principal.scopes` was typechecked against a value that nothing had ever inspected.

### Why signing rather than "bind it privately"

Network placement is the right _first_ control and is still required. It is a bad _only_ control: it is invisible in the repo, unenforceable in CI, and silently wrong the first time something is exposed by an ingress rule nobody re-read. A signature is checkable by a test.

So: the edge HMACs the exact bytes it forwards; the service verifies before believing anything.

**The property, stated plainly:** reaching the port is no longer sufficient to become someone. You need the secret.

### What is now enforced in code

- `createEdgeContext` **throws at boot** on a missing or under-32-char secret. A service that cannot authenticate the edge does not start — it does not start and serve everything as anonymous, which is the failure mode that looks like "no traffic yet" until the first forged withdrawal.
- Verification **fails closed** in every direction: bad signature, unparseable JSON, wrong shape, or expired → `null` principal, i.e. anonymous. There is no branch where a principal survives with some claims unverified.
- The signature covers the **raw header string**, not a re-serialised object — JSON key order is not canonical, so signing a parsed-and-restringified value would authenticate different bytes than the ones that arrived.
- **Expiry is checked**, because a signature proves the edge said it, not that the edge said it recently. Otherwise a captured header is replayable forever.
- `EDGE_PRINCIPAL_SECRET` has **no default**, and is merged only into services that mount. A gateway-only service has no edge header to verify, and demanding the secret there turns it into boilerplate people copy without meaning.

**18 tests**, including a self-escalation attempt replayed under a captured signature, single-byte tamper, non-hex/truncated/over-long signatures, a correctly-signed payload of the wrong shape, and the exact expiry instant.

**Mutation-tested**: forcing `signatureMatches` to `return true` fails 4 tests, the escalation one among them. A suite that passes on its first run has not yet proved it can fail.

---

## For the graph — mechanical mount recipe

Per service, copy `services/svc-agents/src/index.ts`:

1. `import { createEdgeContext } from '@intafaced/contracts';`
2. `import { edgeEnvSchema } from '@intafaced/config';` → `serviceEnvSchema.merge(edgeEnvSchema)`
3. Build the context factory **before** `app.listen`:
   ```ts
   const edgeContext = createEdgeContext({
     secret: env.EDGE_PRINCIPAL_SECRET,
     serviceName: env.SERVICE_NAME,
   });
   ```
4. `createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id })`

**Never** hand-roll the context object. If a mount PR contains `JSON.parse` on a header, that is the bug this page exists to prevent.

### Still open, and not mine to close

- **`HTTP_HOST` still defaults to `0.0.0.0`.** Signing means that is no longer a full auth bypass, but a money service should not bind every interface by default. Left alone deliberately — changing a shared default while the graph is mid-mount is how you break eleven services at once. Worth a follow-up once mounts are stable.
- **The edge itself does not exist yet.** `encodePrincipal` + `signPrincipalHeader` are the contract it must implement. Until something calls them, every request is anonymous — which is the correct failure direction, but means a mounted service is not yet reachable _as a user_.
- **No rate limiting, no request size cap** on mounted services.

---

## Links

- Implementation: `packages/contracts/src/edge.ts`
- Tests: `packages/contracts/src/edge.test.ts`
- Reference mount: `services/svc-agents/src/index.ts`
- P0-3 (blocks public money env): `P0-3-purpose-keyed-holds.md` (removed)
