# INTAFACED

An exchange, a bank and a payments platform on one custodial ledger.

> Rules for people and AI agents: [`AGENTS.md`](AGENTS.md).
> What is where, and how it fits together: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
> How we work together: [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Status

<!-- tracker:start -->

`███████████████████░` **96%** — 157 of 163 features shipped

Phases: **0** ✅ · **1** ✅ · **2** ✅ · **3** ✅ · **3P** 14/15 · **4** ✅ · **4P** 0/2 · **5** ✅ · **5P** 4/7

**🟢 1 ready to claim** — nothing blocks these:

- `socket.clob-contracts` — An audited venue contract emitting the indexed event surface

Full board: **[docs/TRACKER.md](docs/TRACKER.md)** · `pnpm tracker ready`

<!-- tracker:end -->

---

## Run it

Needs Node 20 or newer, pnpm 10 and Docker (`package.json`).

**The whole platform: every service, both apps, and the infrastructure.**

```bash
pnpm install
cp .env.example .env        # read the header: two secrets must match fleet-wide
pnpm platform:up            # docker compose -f docker-compose.apps.yml up -d --build
```

Services, ports and required settings: [`docs/SERVICES.md`](docs/SERVICES.md); local run steps: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ("Run it locally"). The customer site is then on http://localhost:8090 and the admin console on http://localhost:3100.

**Just the infrastructure, for tests:**

```bash
pnpm infra:up               # postgres, redis, nats, otel, tempo, prometheus, grafana, two throwaway anvil chains
pnpm build
pnpm test
pnpm gate                   # the per-service Definition of Done
```

| Service    | Address                            | Dev credentials           |
| ---------- | ---------------------------------- | ------------------------- |
| Postgres   | `localhost:5433`                   | `intafaced` / `intafaced` |
| Redis      | `localhost:6380`                   | none                      |
| NATS       | `localhost:4222` (monitor `:8222`) | none                      |
| Grafana    | http://localhost:3001              | `intafaced` / `intafaced` |
| Prometheus | http://localhost:9090              | none                      |
| Tempo      | `localhost:3200`                   | none                      |

These credentials are for local development only.

---

## Layout

```
apps/        customer (React, Vite) · admin (Next.js) · invitation (React, Vite) · mobile (Capacitor wrapper)
services/    svc-ledger · svc-identity · svc-trade · svc-pay · svc-bank · ...   (25 run in compose)
packages/    ledger-client · contracts · events · config · auth · db · ui · ...
tooling/     agent-protocol · ci · infra · scripts
docs/        README.md (index of live docs) · ARCHITECTURE.md · adr/ · runbooks/ · archive/ (history)
```

Money moves only through `packages/ledger-client`. Pro trading shapes served to outside software live in `packages/exchange-contract`; routing to outside venues is `packages/venue-adapter`.
