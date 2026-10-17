# Ledger caller binding (OPS-0001)

svc-ledger used to check that a caller knew the one shared `INTERNAL_SERVICE_SECRET`, then post whatever `module` the body claimed. Every service that holds that secret could post any recipe.

The key id is the header callers already send: `x-intafaced-service`. Its value names the service and selects that service's HMAC secret (`LEDGER_CALLER_SECRET_SVC_PAY` for `svc-pay`, and the same pattern for the other callers). A signature that matches that secret is a verified caller. The body `module` must be the module that caller's recipe is allowed to carry. The allowlist is `src/caller-allowlist.ts`. Each row cites a production `recipes.<name>(` call.

## What a pull does

`LEDGER_CALLER_BINDING` defaults to `report`. You do not need new secrets.

In report mode the shared `INTERNAL_SERVICE_SECRET` still authenticates a post, and the post still lands. A body whose recipe or module is outside the claimed service is logged (`ledger caller binding violation`) and counted. It is not refused.

Reads (balance, history, and the other `/trpc/*` routes) still use the shared secret in both modes. This change is about who may post.

Compose passes the new variables with empty defaults (`:-`, not `:?`). An empty value means unset. `docker-compose.apps.yml` will still start if `.env` has only the shared secret. `tooling/scripts/local-test-stack.mjs` does not set the flag, so the local stack stays in report mode.

## Turning enforce on later

Do this only after each posting service signs with its own secret. Setting `enforce` first makes every post that still uses the shared secret return `401` `ledger.caller_unbound` and book nothing.

1. Generate one secret per posting service (`openssl rand -base64 48`). At least 32 characters. Do not commit them.
2. Give svc-ledger `LEDGER_CALLER_SECRET_SVC_<NAME>` for that service.
3. Give that same value to the calling service and pass it into `serviceAuthHeadersForBody('<service>', secret, body)` instead of `INTERNAL_SERVICE_SECRET`. The header stays `x-intafaced-service: <service>`. This repo does not switch the callers yet, so a pull cannot 401 a stack that only has the shared secret.
4. Watch the violation log until the callers you care about are quiet, then set `LEDGER_CALLER_BINDING=enforce`.

`enforce` refuses three cases:

- shared secret only (`ledger.caller_unbound`, 401) — no verified service
- a verified service posting a recipe it does not call (`ledger.caller_forbidden`, 403)
- a verified service whose body `module` is not the module that recipe uses for that service (403) — this is the spoofed module

The tRPC `post` mutation applies the same allowlist. It treats `ctx.service` as verified only when `ctx.serviceAuth` is `dedicated` (the HMAC matched that service's own secret). Anything else is a claim, and enforce refuses it. The process does not mount that router. `createEdgeContext` still checks only the shared secret and does not set `serviceAuth`, so mounting it later would refuse every post in enforce until that factory learns the per-service keys. The HTTP `/trpc/post` route is the door that checks the key today.
