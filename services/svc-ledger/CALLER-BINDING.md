# Ledger caller binding (OPS-0001)

svc-ledger used to check that a caller knew the one shared `INTERNAL_SERVICE_SECRET`, then post whatever `module` the body claimed. Every service that holds that secret could post any recipe.

The key id is the header callers already send: `x-intafaced-service`. Its value names the service and selects that service's HMAC secret (`LEDGER_CALLER_SECRET_SVC_PAY` for `svc-pay`, and the same pattern for the other callers). A signature that matches that secret is a verified caller. The body `module` must be the module that caller's recipe is allowed to carry. The allowlist is `src/caller-allowlist.ts`. Each row cites a production `recipes.<name>(` call.

## What a pull does

`LEDGER_CALLER_BINDING` defaults to `report`. You do not need new secrets.

In report mode the shared `INTERNAL_SERVICE_SECRET` still authenticates a post, and the post still lands. Every one of those posts is counted with reason `unbound` and the service name the caller claimed. A body whose recipe or module is outside that claim is counted as well. The warning line is `ledger caller binding violation`, with the running count. It is written the first time for a claimed service, then at most once a minute for that service. The count is not limited. A quiet log is not a zero count.

Reads (balance, history, and the other `/trpc/*` routes) still use the shared secret in both modes. This change is about who may post.

Compose passes the new variables with empty defaults (`:-`, not `:?`). An empty value means unset. `docker-compose.apps.yml` will still start if `.env` has only the shared secret. `tooling/scripts/local-test-stack.mjs` does not set the flag, so the local stack stays in report mode.

## Turning enforce on later

Do this only after each posting service signs with its own secret. Setting `enforce` first makes every post that still uses the shared secret return `401` `ledger.caller_unbound` and book nothing.

1. Generate one secret per posting service (`openssl rand -base64 48`). At least 32 characters. Do not commit them.
2. Give svc-ledger `LEDGER_CALLER_SECRET_SVC_<NAME>` for that service.
3. Give that same value to the calling service and pass it into `serviceAuthHeadersForBody('<service>', secret, body)` instead of `INTERNAL_SERVICE_SECRET`. The header stays `x-intafaced-service: <service>`. This repo does not switch the callers yet, so a pull cannot 401 a stack that only has the shared secret.
4. Set `LEDGER_CALLER_BINDING=enforce` only when the unbound count is 0 for every posting service and allowlist violations are 0, over a full business cycle. A quiet violation log alone is not that signal. Shared-secret posts are counted as unbound even when the claimed service is allowed to send the body, and the warning is rate-limited, so the log can go quiet while the count is still above zero.

`enforce` refuses three cases:

- shared secret only (`ledger.caller_unbound`, 401) — no verified service
- a verified service posting a recipe it does not call (`ledger.caller_forbidden`, 403)
- a verified service whose body `module` is not the module that recipe uses for that service (403) — this is the spoofed module

The tRPC `post` mutation applies the same allowlist. It treats `ctx.service` as verified only when `ctx.serviceAuth` is `dedicated` (the HMAC matched that service's own secret). Anything else is a claim, and enforce refuses it. The process does not mount that router. `createEdgeContext` still checks only the shared secret and does not set `serviceAuth`, so mounting it later would refuse every post in enforce until that factory learns the per-service keys. The HTTP `/trpc/post` route is the door that checks the key today.

`local-test-fund` (`tooling/scripts/local-test-stack.mjs`) and both `order-path-smoke.mjs` copies (`tooling/scripts/` and `services/svc-trade/scripts/`) are refused under enforce, by design. They are not on the allowlist.
