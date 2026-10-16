# Running the platform

> **CORRECTION 2026-10-16.** The eleven-service count, the "two Next apps" line, the 21-container check, and any `apps/web` sentence below are stale. The current map is [`ARCHITECTURE.md`](ARCHITECTURE.md). `pnpm platform:up` and `pnpm infra:up` still match the root `package.json`. Re-check `docker-compose.apps.yml` before trusting a container count in this file.

Bring the fleet up with the commands below. What is in the fleet is [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## From a clean clone

```bash
git clone https://github.com/Phantom-X-007/intafaced.git
cd intafaced

cp .env.example .env      # the two fleet secrets — read the header of that file
pnpm install

pnpm platform:up          # docker compose -f docker-compose.apps.yml up -d --build
```

Tip-image law (D26-P2-04): [`FLEET-TIP-IMAGES.md`](ops/FLEET-TIP-IMAGES.md) — local `--build`, staging digest + `--no-build`, never Hub-pull `intafaced/app:dev`.

First run builds the image (~3–6 min, mostly `pnpm install` and `next build`).
After that, a full teardown-to-healthy cycle is about **100 seconds**.

You do **not** need to run migrations. You do **not** need to start the infra
separately. `platform:up` does both — see [Boot order](#boot-order).

### Did it work?

```bash
pnpm platform:ps
```

Twenty-one containers. Every `svc-*`, `web` and `admin` should read
`Up … (healthy)`, and `intafaced-migrate` should read `Exited (0)` — it is a
one-shot and exiting is what success looks like.

Then ask the services themselves:

```bash
# Public doors only (L5-7: S2S services are not published on the host)
curl -s http://localhost:4000/health; echo   # svc-edge
curl -s http://localhost:4014/health; echo   # svc-ws

# Full fleet health is `pnpm platform:ps` (compose healthchecks). S2S containers
# talk on the docker network — do not expect localhost:4001–4013 to answer.
```

Two more checks worth doing once, because they prove the wiring rather than the
process:

```bash
# 8 JetStream streams, and svc-trade's 2 consumers on INTAFACED_MATCHING
docker exec intafaced-nats sh -c "wget -qO- 'http://localhost:8222/jsz?streams=1&consumers=1'"

# every migration applied, exit 0
docker compose -f docker-compose.apps.yml logs migrate
```

---

## Commands

| Command               | What it does                                                 |
| --------------------- | ------------------------------------------------------------ |
| `pnpm platform:up`    | Build if needed, then bring up **everything**                |
| `pnpm platform:ps`    | Status of all 21 containers                                  |
| `pnpm platform:logs`  | Follow all logs (`… logs -f svc-trade` for one)              |
| `pnpm platform:down`  | Stop everything, **keep** the data                           |
| `pnpm platform:reset` | Stop, **destroy every volume**, rebuild, come back up        |
| `pnpm infra:up`       | Postgres + Redis + NATS + observability **only** — for tests |
| `pnpm infra:down`     | Stop just the infrastructure                                 |

`infra:*` and `platform:*` share one compose project (`intafaced`), so they see
the same containers and the same volumes. `platform:up` after `infra:up` adds
the application containers to what is already running; it does not restart the
database.

### Optional investor outreach runtime

The outreach overlay is opt-in; the default `pnpm platform:up` does not enable
guest intake, CRM storage, or provider delivery. After supplying every required
owner value listed in `.env.example`, run:

```bash
docker compose -f docker-compose.apps.yml -f docker-compose.outreach.yml up -d --build
```

The overlay requires the existing ordered founder identities, distinct identity
authority/admission keys with their exact service-side mappings, an OPS-owned
database URL and positive pool size, the owner-reviewed CRM configuration,
one dedicated OPS-to-notify ingress key mapped to both service env names, admin
HTTPS session settings, an authenticated email gateway, and approved public
contact/retention build values. These are
configuration inputs, not evidence that a host, founder identity, provider,
domain, or delivery route has been verified.

The admin ingress must preserve its configured public `Host`, overwrite
`X-Forwarded-Proto` with one `https` value and keep the Next listener private.
Next can construct request URLs using its internal host; the BFF validates the
preserved public authority while retaining browser Origin, CSRF and current
founder checks. See `apps/admin/README.md` for the exact proxy contract. This
local Compose overlay does not provision that ingress or prove deployed TLS.

On a **fresh local development volume**, `tooling/infra/postgres-init/01-service-schemas.sql`
creates the dedicated `svc_ops` role and `ops` schema alongside `svc_core_ops`
and `core_ops`. The CRM service owns and runs its own transactional migrations
on startup; the general `migrate` container does not apply them. For an existing
volume, the init script will not rerun. A database administrator must create
the dedicated role/schema with explicit database `CONNECT` and schema ownership
for the CRM's own migrations before setting `OPS_DATABASE_URL`. Database `CREATE`
is not required once the owned schema exists. Do not solve this with a broad
grant, `intafaced_ops`, or the local `svc_ops` development password. Production
role credentials must come from the production secret manager.

The base Postgres `pgdata` volume is already durable. Guest notification rows
use the existing svc-notify-owned schema/migration and database connection.
`NOTIFY_EMAIL_GATEWAY_URL` and token must implement the committed guest
notification HTTP contract; SMTP or a generic provider API is not automatically
compatible. Compose configuration does not probe delivery.

The two founder accounts do not exist yet. Bootstrap the real identity and edge
runtime with guest CRM capture unavailable, then use the existing `/register`
and `/uc/safe` screens. Each founder completes their own TOTP or WebAuthn
enrollment. Verify both live active users and bind the exact ordered pair before
enabling the outreach overlay. The general registration screen is not a founder
invitation; no fixture IDs or enrolled security credentials belong in production.

The approved outreach policy is six **UTC calendar months** after the latest
meaningful contact across linked originals. Set the existing configuration member
`retention` to `{"publishedPolicy":"six_calendar_months_v1","automationEnabled":true}`
when the live notification-erasure dependency is ready. Internal notes, assignment,
automatic acknowledgements, page views and token refresh do not renew that clock.
Active discussions require an evidenced founder review that expires within 30
days; this review period is separate from the maximum backup lifetime. Inspect
the actual retention status and aged-record result, not just an environment value.
The service's last invocation timestamp does not prove a completed sweep.

Configure encrypted **outreach-only** backups, restricted keys and scheduled
expiration/disposal within 30 days, including any restorable replicas or WAL.
Do not apply this outreach policy to ledger or statutory records. Preserve the
latest durable, independently protected deletion archive for as long as a
restorable copy needs it. Restore while quarantined; apply the current archive,
reconcile notification deletion and verify that deleted contacts stay deleted
before allowing HTTP traffic or either background worker. A local PostgreSQL
restore test does not prove that hosted backup rotation or disposal is operating.

The public build's approved contact is `mailto:privacy@intafaced.com`. After the
actual policy and backup controls are enabled, its approved notice is:
“Inactive enquiries become due for deletion six calendar months after our last
meaningful contact. We review ongoing discussions separately. Outreach backups
expire within 30 days, and deletion records are applied before restored contacts
become available.” Verify actual receipt at the owned mailbox separately.
Create separate questionnaire/admin deployment surfaces; preserve the existing
`intafaced.com` apex website. Account sign-in and empty deployment projects do
not establish the domain's DNS authority, backend host, database or email gateway.

---

## Ports

Everything binds `localhost`. Nothing here collides with the vendored exchange
stack (5506 / 6381 / 57017 / 9094 / 7000 / 6001).

### Applications (host-published)

| Port     | Service    | Notes                                       |
| -------- | ---------- | ------------------------------------------- |
| **3000** | `web`      | Next storefront / terminal                  |
| **3100** | `admin`    | Operator console                            |
| **4000** | `svc-edge` | **Only HTTP API door** for browsers/clients |
| **4014** | `svc-ws`   | Live depth stream (browser, not via edge)   |

### S2S (compose network only — not on localhost)

| Port | Service         | Notes                       |
| ---- | --------------- | --------------------------- |
| 4001 | `svc-ledger`    | Books only — S2S            |
| 4002 | `svc-identity`  | Accounts, rank              |
| 4003 | `svc-token`     | IFC stake / yield           |
| 4004 | `svc-trade`     | Spot                        |
| 4005 | `svc-matching`  | Engine                      |
| 4006 | `svc-pay`       | Pay + withdraw              |
| 4007 | `svc-p2p`       | Escrow                      |
| 4008 | `svc-agents`    | Model gateway               |
| 4009 | `svc-bank`      | Spaces / earn               |
| 4010 | `svc-dex`       | Protocol quote door         |
| 4011 | `svc-blueprint` | Onboarding                  |
| 4012 | `svc-protocol`  | Smart accounts              |
| 4013 | `svc-indexer`   | Chain read models (propped) |

L5-7: pure S2S services use `expose` only so a host-open laptop is not a second money plane.

### Infrastructure

| Port       | What                                                      |
| ---------- | --------------------------------------------------------- |
| **5433**   | Postgres (5432 inside the network; a native PG owns 5432) |
| **6380**   | Redis (6379 inside)                                       |
| **4222**   | NATS client                                               |
| **8222**   | NATS monitoring — `/healthz`, `/jsz`                      |
| **4317/8** | OTLP gRPC / HTTP                                          |
| **3200**   | Tempo                                                     |
| **9090**   | Prometheus                                                |
| **3001**   | Grafana (`intafaced` / `intafaced`)                       |

---

## Boot order

Encoded in `docker-compose.apps.yml` as `depends_on` conditions, and taken from
the code rather than from a guess. Three kinds of dependency exist and they are
not interchangeable.

```
postgres ──┐
           ├─→ migrate (one-shot, exits 0) ──┐
nats ──────┘                                 │
                                             ├─→ svc-ledger ─┬─→ svc-token
                                             │               ├─→ svc-pay
                                             │               ├─→ svc-p2p
                                             │               ├─→ svc-bank
                                             │               ├─→ svc-agents
                                             │               └─→ svc-trade
                                             ├─→ svc-identity ──→ svc-trade
                                             ├─→ svc-blueprint
                                             └─→ svc-protocol

nats ──────────→ svc-matching ──────────────────────────────────→ svc-trade

(no dependencies) web, admin
```

**1 · Schema assertions.** Nine services run a `SELECT 1 FROM <schema>.<table>`
at boot and `throw` if it fails — `agents.agent_definitions`, `bank.spaces`,
`blueprint.blueprints`, `identity.users`, `p2p.p2p_trades`, `pay.merchants`,
`token.token_params`, `trade.markets`, and svc-protocol's
`information_schema` lookup for `protocol.smart_accounts`. svc-ledger reads its
`chain_tip` row. All ten therefore wait on
`migrate: condition: service_completed_successfully`.

**2 · Stream ownership.** `JetStreamEventBus.connect` creates streams only for
the modules listed in `ownedStreams`
(`packages/events/src/jetstream-bus.ts`). **svc-trade owns none** —
`ownedStreams: []` — but it subscribes to `orderFilled` and `orderCancelled`,
which the catalog places on the `matching` stream, and it publishes
`intafaced.identity.xp.earned` on the `identity` stream. So svc-trade waits on
both svc-matching and svc-identity. Without that gate it exits at boot with:

```
NatsError: stream not found
  api_error: { code: 404, err_code: 10059, description: 'stream not found' }
```

**3 · HTTP callees.** Six services hold a ledger client. Most connect lazily, so
this is ordering rather than a hard boot requirement — with one exception:
**svc-p2p runs its settlement sweep once _before_ the HTTP listener opens**, and
that sweep posts to the ledger. For svc-p2p, svc-ledger is a genuine boot
dependency.

**Not dependencies, checked:** svc-pay and svc-bank open no bus connection at
all (their `index.ts` says so), so neither waits on NATS. svc-matching has no
`DATABASE_URL` — §5.1 gives it in-memory books and a file journal — so it does
not wait on `migrate`. `apps/web` is not in this tree. The customer site proxies
`/api/` to `svc-edge` and `/ws/` to `svc-ws` (`apps/customer/nginx.conf`).
`apps/admin` is the Next operator console.

---

## Migrations

A single one-shot container (`migrate`) runs every service's `db:migrate` and
exits. Everything with a schema waits on
`condition: service_completed_successfully`.

The alternatives and why they lost are argued at the top of
`tooling/infra/migrate-all.mjs`. Short version: an entrypoint step runs once per
_replica_ and races itself the moment anything scales past one; per-service init
containers are correct but spread one question across ten places to look.

Each service migrates **as its own Postgres role** (`svc_ledger`, `svc_trade`,
…), never as `intafaced_ops`. Those roles own exactly one schema and hold no
database-level `CREATE`, so a migration that strays outside its own schema fails
here, in dev, with a permission error — instead of quietly becoming two services
sharing a table. Every runner is idempotent, so `up` re-runs them for free.

---

## Environment

One `.env`, copied from `.env.example`. Read that file's header — the two
variables at the top are the ones that break the platform silently.

`EDGE_PRINCIPAL_SECRET` and `INTERNAL_SERVICE_SECRET` must hold the **same value
across the whole fleet**. The edge signs a principal with the first and each
mounting service verifies it; svc-ledger checks the second and the six services
that post to it send it. Two different values means a platform that starts,
reports healthy, and 401s every authenticated request and every ledger post.

Three things make that hard to get wrong:

1. `.env.example` declares each of them **once**, at the top, with the reason.
2. `docker-compose.apps.yml` references them through a single YAML anchor, so
   there is one place in the compose file where each value comes from.
3. Both use compose's `${VAR:?message}` form — **if either is unset, compose
   refuses to start anything** and prints the message. There is no partial
   bring-up to debug.

Container-side connection strings are set by compose and are **not** read from
`.env`: inside the network the database host is `postgres:5432`, not
`localhost:5433`. The `DATABASE_URL` in `.env` is for processes you run on the
host — `pnpm dev`, `vitest`, `psql`.

---

## When it does not come up

**`required variable EDGE_PRINCIPAL_SECRET is missing a value`**
You have no `.env`. `cp .env.example .env`.

**A service sits in `Restarting`**
Read its logs first — every failure in this stack is loud at boot by design:

```bash
docker compose -f docker-compose.apps.yml logs svc-trade --tail 40
```

- `EnvError: Invalid environment for <service>` — the message lists every
  missing or malformed variable at once. Fix them all, then `pnpm platform:up`.
- `<schema> schema is missing — run migrations before starting <service>` — the
  `migrate` container failed. `docker compose -f docker-compose.apps.yml logs migrate`.
- `NatsError: stream not found` — a service reached the bus before the service
  that owns its stream. If you started containers by hand, start them through
  compose instead so `depends_on` applies.

**`bind: address already in use`**
Something on the host owns the port. Postgres and Redis are overridable
(`POSTGRES_HOST_PORT`, `REDIS_HOST_PORT` in `.env`); the application ports are
fixed in the compose file because they were chosen to stop the services
colliding with each other — change them there, and change the matching
`LEDGER_URL` / `MATCHING_URL` / `IDENTITY_URL` in the same edit.

**`svc-protocol` is healthy but `/ready` returns 503**

```json
{ "ready": false, "reason": "HTTP request failed ... http://host.docker.internal:8545/" }
```

Expected. The Protocol Plane needs an EVM RPC and the compose stack does not run
one — the chain is not ours (§17.2). Start an `anvil` on the host and it will
be found at `host.docker.internal:8545`, or point `PROTOCOL_RPC_URL` elsewhere
in `.env`. Nothing else in the platform depends on it.

**`svc-blueprint` reports `engine.usable: false`**
Also expected, and harmless: the mock engine fixes its `lastUpdate` at
construction and `isUsable()` calls anything older than 60 seconds stale, so an
in-process mock reports unusable one minute after boot. `/ready` still returns
200 and `BLUEPRINT_ENGINE_MODE=mock` still serves deterministic profiles. Point
`BLUEPRINT_ENGINE_MODE=http` at a real Neural Engine deployment for the real
thing.

**Everything is healthy but nothing works**
Check the two shared secrets are identical everywhere — see above. That failure
mode is silent by nature: healthy processes, 401 on every real call.

**Start over**

```bash
pnpm platform:reset      # destroys every volume, including the ledger
```

---

## The image

One image (`intafaced/app:dev`, ~1.5 GB) for all thirteen containers. The
Dockerfile's header argues why one and not thirteen; the short version is that
a pnpm workspace with shared `@intafaced/*` packages builds once, and thirteen
images would be the same `pnpm install` and the same `packages/contracts` build
repeated thirteen times. Each container is told which process to be by
`command:` in the compose file.

It runs as the non-root `node` user, installs with `pnpm install
--frozen-lockfile`, and `.dockerignore` keeps the host's `node_modules` out of
the build context entirely — a pnpm `node_modules` is a forest of absolute
symlinks and copying one from a Windows or macOS host into a Linux image is
either broken or, worse, silently works with whatever was installed there.

It deliberately keeps devDependencies: `tsx` is one, every service's
`db:migrate` runs under it, and the `migrate` one-shot uses this same image on
purpose — so what migrates the database is byte-identical to what then reads it.
