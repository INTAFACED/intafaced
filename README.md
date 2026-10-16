# INTAFACED — Sovereign OS

> Rules: [`AGENTS.md`](AGENTS.md). Map of the tree: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
> The July law ([`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md)) is the spec the coverage gate reads. Its shell and layout sentences are corrected at the top of that file.
> This file tells you how to run it.

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

**The whole platform — services, apps, and infrastructure.** What is in the fleet is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The old "eleven services, both apps" count is stale.

```bash
pnpm install
cp .env.example .env        # read the header — two secrets must match fleet-wide
pnpm platform:up            # everything, migrations included
```

Ports, boot order, and what to do when it does not come up:
**[docs/RUNNING.md](docs/RUNNING.md)**.

**Just a database, for tests:**

```bash
pnpm infra:up               # postgres · redis · nats · otel · tempo · prometheus · grafana
pnpm build
pnpm test
pnpm gate                   # the §14 Definition of Done gate
```

| Service    | URL                                | Credentials               |
| ---------- | ---------------------------------- | ------------------------- |
| Postgres   | `localhost:5433`                   | `intafaced` / `intafaced` |
| Redis      | `localhost:6380`                   | —                         |
| NATS       | `localhost:4222` (monitor `:8222`) | —                         |
| Grafana    | http://localhost:3001              | `intafaced` / `intafaced` |
| Prometheus | http://localhost:9090              | —                         |
| Tempo      | `localhost:3200`                   | —                         |

---

## What's built

**Phase 1 — THE CORE is complete.** `svc-ledger`, `svc-identity`, `svc-token` are on `main`, and Doctrine §0.2 no longer blocks Phase 2.

### The three Core services

**`svc-ledger`** — double-entry, hash-chained, reconciling. The invariants hold in three places: shared validation, the transaction, and database CHECK constraints, so a bug in the service still cannot create money. It runs the same conformance suite as the in-memory reference (§4.4).

**`svc-identity`** — accounts, argon2id, TOTP verified against the RFC's own published vectors, refresh rotation with reuse detection, and the XP graph. One rank, read by every module through a machine-readable perk table.

**`svc-token`** — emission curve, staking ladder, real-yield distribution from actual platform fees, buyback & burn. Holds no balances: the stake principal lives in the ledger, and a test asserts the two answers agree.

### `packages/config`

Typed env loading (fails loud, at boot, listing every problem at once), the feature-flag registry wired to the §11 drop sequence, the module registry, the fiat currency table, and `JURISDICTION_MATRIX` — where §22's sovereignty law is encoded as a function rather than a policy document:

```ts
checkAccess({ module: 'protocol', region: 'US', plane: 'protocol', kycTier: 'none' });
// → { allowed: true, code: 'allowed.permissionless' }   ← no custody, no gate

checkAccess({ module: 'bank', region: 'DE', plane: 'fiat', kycTier: 'basic' });
// → { allowed: false, code: 'denied.kyc_required', requiredTier: 'full' }
```

### `packages/ledger-client`

Doctrine §0.6, made mechanical.

- **`money.ts`** — decimals as scaled bigints. A float never touches a balance. Rounding mode is always explicit, and `proRata` distributions sum back to the exact total, dust included.
- **`client.ts`** — the three invariants, enforced before any implementation sees a transaction: sum-to-zero per asset, no negative `available`, locks funded from the owner's own balance.
- **`recipes/`** — every money path in the OS as a pure function. `deposit`, `tradeFill` (the six-entry atomic fill), `escrowLock/Release/Refund`, `stake`, `feeCharge` with the IFC discount branch, `rewardPay`, `collateralLock`, `liquidate`.
- **`memory-ledger.ts`** — the executable specification svc-ledger must match: idempotency, hash-chained journal, replay reconciliation.

172 tests across 6 files, including the fill arithmetic, the hash chain's tamper detection, and the shared conformance suite both ledger implementations must pass.

### `packages/events`

The subject law — `intafaced.<service>.<entity>.<verb>` — as a validator, not a comment. Unregistered services and present-tense verbs are rejected at build time. Every event is declared in a catalog with a zod payload and a version; payloads are validated on publish _and_ on delivery, so a producer running an old build cannot poison a consumer.

### `packages/auth`, `packages/contracts`, `packages/db`, `packages/ui`

Scopes (note: there is no `ledger:write` — balances never move on a user token), the zod-first tRPC pattern with a working reference router, Drizzle primitives with SERIALIZABLE retry semantics and a per-test-schema harness, and the locked design system: pure black, phosphor `#00FF41`, glass surfaces, Orbitron + Inter, with `Panel · Ticker · RankBadge · StatBlock · LobbyCard`.

### `tooling/ci` — the doctrines, enforced

`pnpm gates` runs all **twenty-eight** in about seventeen seconds, from **one list — `tooling/ci/gates.mjs` — that `pnpm verify` and CI's `gates` job both consume.** One list is the point: they were previously maintained separately and drifted, so two gates ran in CI and nowhere local.

**`tooling/ci/gates.mjs` is the list. The table below is orientation.** Run `node tooling/ci/gates.mjs` for the live set and its per-gate output. This section once claimed “fourteen” while twenty-seven were running and the table was missing twelve of them — which is exactly the drift the gates exist to catch, one level up, so it is recorded rather than quietly corrected. (Twenty-eight since `worktree-gc-selftest` landed.)

The twenty-eight, grouped by what they defend:

| Group                 | Gates                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One book (§0.6)**   | `vendor-java-money` · `dual-book-door` · `dual-book-door-paths` · `money-property-mutation`                                                         |
| **Custody & secrets** | `custody` · `secrets` · `secret-scan-mutation` · `wallet-rpc-auth` · `wallet-rpc-mainnet` · `wallet-rpc-mainnet-mutation` · `compose-secret-parity` |
| **Honesty of claims** | `tracker` · `coverage` · `reachability` · `skip-honesty` · `event-wiring`                                                                           |
| **Surface & brand**   | `brand` · `shell-brand` · `vendor-shell` · `i18n` · `i18n-bypass`                                                                                   |
| **Operability**       | `migrations` · `killswitch` · `workspace` · `test-db`                                                                                               |
| **Coordination**      | `agent-autoload` · `worktree-gc-selftest`                                                                                                           |

Three properties are worth knowing before citing any of them:

- **Several are ratchets, not clean-tree checks.** `shell-brand` (0 frozen), `vendor-java-money` (55 frozen), `wallet-rpc-mainnet` (57 frozen constants), `event-wiring` (1 Class B awaiting an owner decision) and `i18n-bypass` all pass with known findings pinned by exact text. **The queue cannot grow.** A ratchet that failed on its pre-existing set would be routed around and deleted, taking the honest part with it.
- **Four are mutation-tested** — `secret-scan-mutation`, `money-property-mutation`, `wallet-rpc-mainnet-mutation`, `dual-book-door-paths`. A gate nobody has seen fail is not a gate.
- **One guards a tool rather than the product.** `worktree-gc-selftest` runs the 15 classifier fixtures of `tooling/scripts/worktree-gc.mjs`, the only script here that can delete another agent's working state — and which has done so (`docs/LANE-CLOSEOUT-OPS-2026-08-08.md`), and could once have run `git branch -D main`. #1151 fixed it and shipped the fixtures; they were wired to nothing, so reverting the fix broke no check. Now it is red instead: verified by reverting the `LIVE-LANES` board read and watching 2 of 15 fail the gate list.
- **`pnpm gate` (singular) is the §14 Definition of Done**, per service. It is not one of the twenty-eight and runs separately, after build and test.

One is deliberately **not** in the list, for a stated reason: `pnpm scan:deps` (the supply-chain ratchet — needs network, so it is its own workflow). The gates that watched the legacy Vue customer site (`shell-i18n`, `shell-golden`, `fabricated-money`, `lang-duplicate-key`) were retired on 2026-10-13 with that site; `shell-brand` now covers the vendored Java CORS surface only.

They are verified against deliberate violations, not just against a clean tree.

**`scan:custody` is narrower than its name suggests** — it walks four named Protocol Plane services (three exist today) and `svc-protocol`'s Solidity, 97 files. It covers no Java and no other service. The header of `tooling/ci/custody-scan.mjs` states the coverage exactly; read it before citing the gate.

---

## The three shared systems

Doctrine §0.3: **Identity, Balance, Token.** Every cross-module link runs through one of these three. A feature that needs a fourth is a feature whose design is wrong.

```
                    ┌─────────────┐
                    │  IDENTITY   │  one account · one verification · one rank
                    │ svc-identity│  XP events in → perks table out
                    └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
│   BALANCE   │     │    TOKEN    │     │  SURFACES   │
│  svc-ledger │◄────┤  svc-token  │     │ trade · pay │
│             │     │             │     │ p2p · bank  │
│ double-entry│     │ stake · burn│     │ launch · …  │
│ hash-chained│     │  buyback    │     │             │
└─────────────┘     └─────────────┘     └──────┬──────┘
       ▲                                        │
       └────────────────────────────────────────┘
              every value movement, no exceptions
```

---

## Known dependency note

`nats@2.x` is published as deprecated in favour of the split `@nats-io/*` v3 packages. The 2.x client is functional and is what `packages/events` uses today; the migration is isolated to `jetstream-bus.ts` because nothing else imports `nats` directly.

**This note used to say “worth doing before Phase 2 puts real order flow on the bus.” Phase 2 is underway, so that deadline has passed** and the migration is now owed rather than upcoming. Still a single-file change; still nothing else imports `nats`.

---

## Layout

```
apps/          web · admin · ws-gateway            (Phase 2+)
services/      svc-ledger · svc-identity · svc-token   ✅ the Core
               svc-matching · svc-trade · svc-pay · …  (Phase 2+)
packages/      config · events · contracts · db · auth · ledger-client · ui
               exchange-contract   CCXT-shaped API we serve
               venue-adapter       cross-venue routing
tooling/       agent-protocol · ci · infra · tracker
docs/          TRACKER.md · TERMINAL.md · ONBOARDING.md
```

---

## Pro terminal — ours, and cross-venue

We build our own terminal (Next.js, one design system, one language). The symmetry that makes it work:

**CCXT out** — `packages/exchange-contract` publishes a CCXT-compatible API, the interface every trading bot and third-party terminal already speaks. Serving that shape makes INTAFACED a venue for software written before we existed.

**CCXT in** — `packages/venue-adapter` consumes external venues through the same standard, behind the §5.2 `LiquiditySource` interface. The internal book implements that interface too, so the router cannot favour us structurally; it ranks on price, and wins ties by a bounded, tested 5 bps preference.

Money crosses both boundaries as a decimal string, never a float — CCXT's own structures use JS numbers and the ledger reconciles to 18 places.

Architecture: [`docs/TERMINAL.md`](docs/TERMINAL.md). Why we didn't licence an existing one: [`docs/TERMINAL_INTEGRATION.md`](docs/TERMINAL_INTEGRATION.md).
