# The AI gateway socket — one URL, no vendor in the repo

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** operator runbook · **Date:** 2026-08-07
**Law:** `INTERNET-LEVERAGE-PHASE-C-GATEWAY-SOCKETS-2026-08-06.md` (removed) §1
**Code:** [`services/svc-agents/src/providers/upstream.ts`](../services/svc-agents/src/providers/upstream.ts) · [`services/svc-agents/src/env.ts`](../services/svc-agents/src/env.ts)

---

## 0 · Plain English (for Nitro)

`svc-agents` already knows how to talk to a model. It does **not** know, and must never know, **whose** model — the provider is a URL and a key you set at deploy time, not something written into our code.

This adds the thing that URL points at: one container that holds the provider keys, decides which model answers, retries when one is down, and counts what it costs. Five agent features sit behind it and none of them need code changes to use it.

It is **off unless you turn it on**, and it will not start until you supply a config file. Nothing in the repo names a provider, so nothing here is a decision about who we buy from.

---

## 1 · Why a proxy rather than an SDK

Phase C §1 sets this out and it is the reason the socket exists at all.

`providers/upstream.ts` says it in its own header:

> Base URL, request paths, the auth header name, any protocol-version headers, and the map from routing-table model aliases to concrete upstream model ids all arrive through `UpstreamProviderConfig` … This file contains the _shape_ of the conversation and nothing about who is on the other end.

Installing a provider SDK would put a vendor name in source, re-couple provider choice to a release, and hand the brand scan a name it is built to reject. A proxy behind the existing URL gives routing, failover, budgets, caching and cost accounting **without any of that**.

**What is deliberately NOT here:** no change to `svc-agents`. Not one line. If wiring a gateway required editing the service, the socket would not have been a socket.

---

## 2 · Turn it on

### 2.1 Write a config, outside the repo

```bash
mkdir -p ~/.intafaced/secrets
$EDITOR ~/.intafaced/secrets/litellm.yaml
```

The shape, with providers and models left as `<…>` because **this repo may not name them** (§0.7 — `.yaml` is inside the brand scan's extensions, and the scan is right to fire):

```yaml
model_list:
  # `model_name` is OUR alias — the string AGENTS_UPSTREAM_MODELS maps onto.
  # `model` is the provider's own id and belongs only in this file.
  - model_name: primary
    litellm_params:
      model: <provider>/<their-model-id>
      api_key: os.environ/UPSTREAM_PROVIDER_KEY
  - model_name: fallback
    litellm_params:
      model: <other-provider>/<their-model-id>
      api_key: os.environ/OTHER_PROVIDER_KEY

router_settings:
  # Why the gateway earns its place: this is failover we would otherwise write.
  fallbacks: [{ primary: ['fallback'] }]
  num_retries: 2

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Keep aliases stable (`primary`, `fallback`). They are the only model vocabulary the platform sees, which is what lets you change provider without touching a service.

### 2.2 Point the deployment at it

In `.env` (never committed):

```bash
LITELLM_CONFIG_PATH=/home/you/.intafaced/secrets/litellm.yaml
LITELLM_MASTER_KEY=<a long random string you generate>

AGENTS_PROVIDER=upstream
AGENTS_UPSTREAM_BASE_URL=http://litellm:4400
AGENTS_UPSTREAM_API_KEY=<the same LITELLM_MASTER_KEY>
AGENTS_UPSTREAM_AUTH_HEADER=Authorization
AGENTS_UPSTREAM_AUTH_PREFIX='Bearer '
AGENTS_UPSTREAM_MODELS={"default":"primary"}
```

### 2.3 Start it

```bash
docker compose -f docker-compose.apps.yml --profile ai up -d litellm svc-agents
```

Without `--profile ai` the gateway does not start and `svc-agents` stays on `mock`, which is the default and spends nothing.

---

## 3 · The completions path — CHECK THIS, do not assume

`AGENTS_UPSTREAM_COMPLETIONS_PATH` defaults to `/v1/messages`.

That default was chosen for a direct provider, and LiteLLM's coverage of that endpoint has varied across versions while `/v1/chat/completions` has been stable throughout. **This has not been verified end-to-end against a live provider** — see §5 — so treat it as the first thing to test, not as configuration that is known good:

```bash
# From inside the compose network.
docker compose -f docker-compose.apps.yml --profile ai exec litellm \
  sh -c 'curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4400/v1/messages \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "content-type: application/json" \
    -d "{\"model\":\"primary\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"'
```

A 404 means this build does not serve that path — set `AGENTS_UPSTREAM_COMPLETIONS_PATH=/v1/chat/completions` and re-test. Either way it is an env change, not a release.

---

## 4 · What does not change, and must not

| Property                             | Still true                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| No provider named in source          | The gateway holds the names. The repo holds a URL.                                                                                      |
| Metering is ours                     | `UsageMeter` still bills through `ledger-client`. The gateway's cost numbers are for the operator, and are **not** a second money book. |
| The gateway never faces the internet | `expose`, never `ports`. It holds provider credentials.                                                                                 |
| `mock` stays the default             | Bringing the fleet up cannot spend money.                                                                                               |
| Guardrails stay in `svc-agents`      | Tool-calling limits are a product rule, not a proxy setting.                                                                            |

---

## 5 · What is NOT verified

Stated plainly because the rest of this document reads like it works.

- **No live round-trip has been made.** That needs provider credentials, which are Class X and belong to the operator. What is verified: the image digest pulls, `docker compose config` parses with the profile, and the gateway is absent from the default stack.
- **The `/v1/messages` path is unconfirmed** for this build (§3).
- **No cost or latency baseline exists yet.** Once traffic is real, `svc-agents` spans now reach Tempo (#889) and can be compared.

---

## 6 · Turning it off

```bash
docker compose -f docker-compose.apps.yml --profile ai down litellm
```

Then unset `AGENTS_PROVIDER` (or set `mock`). `svc-agents` refuses to boot on `upstream` with no base URL rather than silently answering from nowhere — the honest failure, and the one to keep.
