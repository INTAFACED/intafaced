# Ledger caller binding

svc-ledger decides who is calling from the key that signed the request, not from a name the request claims. Each calling service has its own Ed25519 key pair (S2S v3, see `packages/contracts/src/service-keys.ts`). svc-ledger holds only the public keyring. A service cannot sign as another.

## Settings

| Variable          | Meaning                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `S2S_AUTH_MODE`   | Unset or `off`: the shared `INTERNAL_SERVICE_SECRET` only. `dual`: key or shared secret. `keypair`: key only. |
| `S2S_KEYRING`     | Public keys of every calling service. No secret in it.                                                        |
| `S2S_SIGNING_KID` | With `S2S_SIGNING_KEY`: this service's own signing key, for calls it makes.                                   |
| `S2S_SIGNING_KEY` | Secret. Deploy environment only; never committed.                                                             |

The old `LEDGER_CALLER_BINDING` report/enforce setting and the per-service `LEDGER_CALLER_SECRET_SVC_*` secrets are gone. Setting them does nothing.

## What a door checks

Every door on the service port names the services that may call it (`src/door-callers.ts`). A service that signs with its own key and is not listed is refused with `403 ledger.caller_forbidden`. A door with an empty list refuses every key. Six doors have no caller in this repository yet and stay empty until one exists: `portfolio`, `statementPnl`, `reportExport`, `custody`, `financeClose`, `resilience`.

`post` is open to the services that hold a recipe grant (`src/caller-allowlist.ts`). That list then judges the recipe and the body `module`:

- a verified service posting a recipe it does not call: `403 ledger.caller_forbidden`
- a verified service whose body `module` is not the module that recipe uses for it (the spoofed module): `403`

These refusals apply to every key-signed call, in every mode. A key-signed call that fails (wrong key, wrong audience, replay, tampered body) is refused and never retried under the shared secret.

## The shared secret while services move over

A name claimed under the shared secret is not proof, so it is never refused for its name: callers that have not moved to keys yet, and the local test scripts, sign that way. In `off` and `dual` mode such a call is served, and every post is counted with reason `unbound` under the claimed service, with a rate-limited warning line `ledger caller binding violation` (first for a service, then at most once a minute). The count is not limited; a quiet log is not a zero count. When the count is 0 for every posting service over a full business cycle, switch to `keypair`, which refuses the shared secret at the door.

One exception: the token buyback recipes (`buybackOrderHold`, `buybackOrderHoldRelease`, `buybackTakerFill`; `KEY_REQUIRED_RECIPES` in `src/caller-binding.ts`) are refused `ledger.caller_unbound` under the shared secret whenever keys are configured (`dual` or `keypair`), granted name or not. They move the rewards engine's quote and pay a customer from it, so a claimed name must not post them. With S2S off they are counted like any other post. Rollout order: svc-trade signs with its key before svc-ledger turns keys on while the buyback runs, or its holds, fills and releases are refused (a refused hold leaves no order; a refused fill leaves the buyback's quote in its own hold and the customer maker's base in their order hold until reconcile).

`local-test-fund` and `local-test-seed` (`tooling/scripts`) and both `order-path-smoke.mjs` copies sign with the shared secret and are not on any list. They keep working in `off` or `dual` and stop working in `keypair`, by design.

## Mounted surface

The raw Fastify routes in `src/s2s-http.ts` are what the port serves. The tRPC `post`, `history` and `historyPage` procedures are exported for their type and carry the same caller lists; they treat a name as proven only when the context says `serviceAuth: 'keypair'`.
