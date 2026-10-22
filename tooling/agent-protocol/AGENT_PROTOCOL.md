# Agent protocol

The rules every agent follows are in [`AGENTS.md`](../../AGENTS.md). This file keeps the detail that other files cite by section number (`AGENT_PROTOCOL §0`, `§1`, `§2`, `§3`, `§5`, `§8`). What is where: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

---

## 0 · Before you touch anything

1. Read `AGENTS.md`.
2. Read the target service's `README.md`.
3. Read this file.

If the task is ambiguous, ship refuse-closed: an unset price, limit, provider or list refuses with a typed error. Never guess on money, custody or sanctions.

---

## 1 · Scope of a task

**One service per task.** A PR touches one `services/*` directory plus, at most, its own tests and README; a slice PR may also carry its contracts or events and that service's screen (below).

A slice is the one exception: its `packages/contracts` or `packages/events` change, one service and that service's screen land as one PR (owner decision 2026-10-22, AGENTS.md "Services and events" item 2).

Any other cross-service work is **two PRs, in order**:

1. A `packages/contracts` and/or `packages/events` PR that declares the new interface or event. Reviewed on its own.
2. The service PR that implements against it.

Never the reverse. The contract is the design review.

---

## 2 · Hard prohibitions

A PR that does any of these is rejected.

| Never                                                                     | Instead                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Write raw SQL against another service's tables                            | tRPC through `packages/contracts`, or an event through `packages/events`                |
| Move value outside `packages/ledger-client`                               | Add a recipe in `packages/ledger-client/src/recipes/`                                   |
| Hold a balance in your service                                            | An account kind in the ledger                                                           |
| Store money in a `number`                                                 | `parseAmount` / `formatAmount`, `numeric(38,18)`                                        |
| Assemble ledger entries inline                                            | Call or write a recipe                                                                  |
| Publish an undeclared NATS subject                                        | Add it to `packages/events/src/catalog.ts` first                                        |
| Name a partner or model vendor in user-facing copy                        | Use the product's own names (`pnpm scan:brand`)                                         |
| Import `ledger-client` write recipes from a Protocol Plane service        | `ReadOnlyLedgerClient`, or reconsider the design (`pnpm scan:custody`)                  |
| Adopt a second money book (service balances, an outside system of record) | `packages/ledger-client` recipes only                                                   |
| Invent mids, depth, prices or balances so a screen looks live             | Real feeds, or an honest empty state                                                    |
| Adopt a PSP orchestrator as pay connectivity                              | A thin adapter behind `RailAdapter` (`docs/adr/2026-08-04-pay-rails-and-psp-socket.md`) |
| Share one migrate-on-startup test Postgres across concurrent worktrees    | A dedicated test database per worktree (`pnpm scan:test-db`)                            |

---

## 3 · Verify the change

Run checks that exercise the changed behavior: affected tests, relevant typecheck and build, money invariants where they apply, and `pnpm exec prettier --check` on changed files. Fix failures your change introduced. Report unrelated baseline failures and checks that could not run. Do not claim unverified behavior works.

```bash
pnpm gates     # every entry in tooling/ci/gates.mjs (the list is live; do not hardcode a count)
pnpm verify    # gates, format, build, typecheck, test: a broad local check
pnpm gate      # the per-service Definition of Done (section 8)
```

CI and `pnpm verify` read the same gate list, `tooling/ci/gates.mjs`. A red gate is not a discussion: fix the cause, never weaken the gate. Merging follows `AGENTS.md` ("Check, then merge").

A 403 or 429 from GitHub means stop GitHub requests and report the response. Do not retry in a loop, switch accounts or create a token. Resume a rate-limited request only after `Retry-After` or the `X-RateLimit-Reset` time; if neither is given, wait at least 60 seconds. Resolve an account or permission restriction before resuming. Independent local work continues.

Actions run only this repo's build, test and publish; operational polling such as live market data runs on our own machines. Pace GitHub API calls and avoid repeated status polling.

---

## 4 · Writing a service

Follow `tooling/agent-protocol/SERVICE_TEMPLATE.md`. The shape is not optional: uniformity lets an agent move between services without re-learning anything. Every service has a `README.md` with its API contract, events and ledger recipes.

---

## 5 · Money paths

A money path is any code that leads to a ledger post. It carries stricter rules:

- **At least 95% unit coverage.** Measured, not aspirational.
- **Every recipe has an invariant test.** Sum to zero, no negative available, no stranded funds on any branch.
- **Every failure branch is tested.** Insufficient funds, rail failure, dispute resolution, partial fill, cancel during fill.
- **Idempotency keys are business keys.** `deposit:crypto-native:0xabc`, never `crypto.randomUUID()`. A retry must find the original.
- **Trace attribute `intafaced.money_path=true`** so the collector never samples it away.

Ask of every money path: _if this crashes exactly here, whose funds are stranded?_ If the answer is anyone's, the design is wrong.

---

## 6 · Events

- Subject: `intafaced.<service>.<entity>.<verb>`, past tense, declared in the catalog.
- Consumers are idempotent. Wrap with `idempotent(handler, store, scope)`: delivery is at least once.
- Payloads are versioned. A breaking change is a new version, with both running until consumers migrate.
- Money amounts in payloads are decimal strings.

---

## 7 · Jurisdiction and custody

Before serving a user-facing operation, call `checkAccess({ module, plane, region, kycTier })` and refuse when it is not allowed, or declare it on the procedure with `scopedProcedure('trade:write', { module: 'trade' })`.

Custody decides the rule. If the platform never holds the asset (Protocol Plane), access is permissionless: no KYC, no account gate. If the platform holds the asset or touches fiat or card rails (Fiat Plane), verification is tiered by `packages/config/src/jurisdiction.ts`. A KYC check on the Protocol Plane is a design error.

---

## 8 · Definition of Done

A module ships when `pnpm gate <service>` is green and the manual checklist it prints is signed. A merge is not a launch: deploys, live credentials and real funds need the owner.
